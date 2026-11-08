#!/usr/bin/env python3
"""采集三端 AI 应用（WorkBuddy / OpenClaw / Codex）的技能资产与使用频率。
输出 capability-data.json，供能力中心面板消费。
"""
import json, os, re, sqlite3, subprocess, hashlib
from pathlib import Path
from datetime import datetime, timezone

HOME = Path.home()
NOW = datetime.now(timezone.utc)

# 高频技能的用途统一写成一句中文（description 是英文或过长时用它覆盖）
OVERRIDES = {
    # --- WorkBuddy ---
    'nocobase-data-analysis': '用查询分析 NocoBase 业务数据',
    'weflow-group-summarizer': '微信群聊记录抓取、要点提取与汇总',
    '1920-deck-typography': '1920 宽横版 deck 排版，navy+gold 商务风',
    'agently-mail': '命令行收发邮件：发送、回复、搜索、读附件',
    'nocobase-ai-employee': '配置 NocoBase AI 员工与提示词',
    'taste-skill': '前端审美把关，去掉 AI 味的界面生成',
    'bazi-ziwei': '八字 + 紫微斗数排盘与综合分析',
    'impeccable': '界面设计改版，追求精致的 UI 产出',
    'infographic': '把内容整理成一张信息图',
    'juemu-daily-dispatch-report': '每天 11:00 播报昨日实际来单的派单清单',
    'monthly-network-report': '生成网络获客月度情况专题文档',
    'nocobase-env-manage': 'NocoBase 启动、运行时与环境变量管理',
    'obsidian-cli': '用 Obsidian CLI 读写 vault',
    'signed-customer-reactivation': '从无效项目清单筛出可二次回访项目并评分',
    'skill_2053082275194277888': '图解生成与渲染校验（Excalidraw）',
    'weekly-report': '生成觉木周报/月报并写入 Obsidian',
    'weekly-report-h5': '周报 markdown 转浅色 H5 长图页面',
    'xuan-ti-xia': '从装修决策问题出发建选题池与研究计划',
    # --- OpenClaw ---
    'docker-app-delivery': '把本地工具打包成 Docker 镜像交付',
    'deck-to-obsidian': '分享稿归档，或从录音转写里挑引用素材',
    'douyin-creator-publish': '发布或修改抖音图文作品',
    'ai-chat-share-harvest': '从 AI 对话分享链接里抓引用网页',
    'douyin-local-video-copy': '本地视频提语音文字，写抖音标题概述标签',
    'douyin-transcript': '抖音视频转音频再转文字稿',
    'find-skills': '发现并安装新的 OpenClaw 技能',
    'footage-frame-index': '视频抽帧 + 帧内容标注 + 索引表',
    'tavily-search': 'Tavily 联网搜索',
    'pbootcms-commercial-publisher': '把案例发布到觉木 PBootCMS 商业空间栏目',
    'terminal-command-execution': '安全可靠地执行终端命令',
    'comparison-article-series': '竞品对比稿改写为以我方为首推的系列稿',
    'competitor-notes-extraction': '竞品图文素材提炼与选题库',
    'generator-rule-layer': '从参考作品反推批量生成的规则层',
    'marketing-image-text-check': '核验 AI 营销图上的文字与事实',
    'meeting-to-strategy-report': '会议记录整理成给赵总汇报的方案',
    'repo-dev-resume': '接着开发某项目，恢复上次上下文',
    'script-to-clip-timeline': '混剪脚本拆成剪辑时间线',
    'csv-to-excel': 'CSV 转成排版好的 Excel',
    'geo-knowledge-center': 'GEO 观点文章生产流水线',
    'juemu-group-daily-report': '觉木公装群日报生成',
    'juemu-short-video-copy': '觉木短视频口播脚本生成',
    'nocobase-lead-bridge': '读 NocoBase 线索表，字段中文映射与解析',
    'feishu-doc': '飞书文档读写工作流',
    'nano-pdf': '用自然语言改 PDF',
    'openai-whisper': '本地语音转文字（Whisper CLI）',
    # --- Codex ---
    'justskill-design': '用 HTML 做网页设计稿并在画布上微调',
}


def read_front(path):
    """解析 SKILL.md 的 YAML frontmatter（只取 name/description）。"""
    try:
        txt = path.read_text(encoding='utf-8', errors='ignore')
    except Exception:
        return '', ''
    name = desc = ''
    if txt.startswith('---'):
        end = txt.find('\n---', 3)
        fm = txt[3:end] if end > 0 else ''
        m = re.search(r'^name:\s*(.+)$', fm, re.M)
        if m:
            name = m.group(1).strip().strip('"\'')
        m = re.search(r'^description:\s*(>-?|\|)?\s*([\s\S]*?)(?=\n[a-zA-Z-]+:|\Z)', fm, re.M)
        if m:
            desc = re.sub(r'\s+', ' ', m.group(2)).strip()
    return name, desc


def brief(desc, limit=38):
    """从 description 提取一句中文用途。优先第一个中文片段；纯英文就截前几十字符。"""
    if not desc:
        return ''
    desc = re.sub(r'\s+', ' ', desc).strip().strip('"\'')
    zh = re.search(r'[\u4e00-\u9fa5][^。！？]{3,}', desc)
    seg = (zh.group(0) if zh else desc).strip(' 。.,，、')
    seg = re.sub(r'\s+', ' ', seg)
    if len(seg) > limit:
        head = seg[:limit]
        cut = max(head.rfind('，'), head.rfind('、'), head.rfind('：'), head.rfind(','), head.rfind(' '))
        seg = head[:cut] if cut >= 12 else head.rstrip('，,、 ') + '…'
    return seg


def dir_hash(p):
    """目录内容哈希（跟随符号链接）。"""
    h = hashlib.sha1()
    files = []
    for root, _, fs in os.walk(p):
        for f in fs:
            files.append(os.path.join(root, f))
    for f in sorted(files):
        h.update(os.path.basename(f).encode())
        try:
            h.update(Path(f).read_bytes())
        except Exception:
            pass
    return h.hexdigest()[:8], len(files)


def mtime_date(p):
    """目录下最新文件时间；过滤被写成 1980 之类的假时间戳，兜底用目录本身。"""
    FLOOR = 946684800  # 2000-01-01
    try:
        ts = [os.path.getmtime(os.path.join(r, f))
              for r, _, fs in os.walk(p) for f in fs]
        ts = [t for t in ts if t > FLOOR]
        if not ts:
            ts = [os.path.getmtime(p)]
        return datetime.fromtimestamp(max(ts)).strftime('%Y-%m-%d')
    except Exception:
        return ''


# ---------- WorkBuddy ----------
def collect_wb():
    base = HOME / '.workbuddy' / 'skills'
    usage = {}
    ulog = HOME / '.workbuddy' / 'usage-log.json'
    if ulog.exists():
        d = json.loads(ulog.read_text())
        for k, v in d.get('skills', {}).items():
            usage[k] = {
                'last': v.get('lastUsedDate', ''),
                'days': len(v.get('recentDates', [])),
                'first': v.get('firstSeenDate', ''),
            }
    items = []
    if not base.is_dir():
        return items
    for d in sorted(base.iterdir()):
        sk = d / 'SKILL.md'
        if not d.is_dir() or not sk.exists():
            continue
        name, desc = read_front(sk)
        key = d.name
        u = usage.get(key) or usage.get(name) or {}
        items.append({
            'key': key,
            'name': name or key,
            'use': u.get('days', 0),
            'last': u.get('last', ''),
            'brief': brief(desc),
            'mtime': mtime_date(d),
            '_desc': desc,
        })
    return items


# ---------- OpenClaw ----------
def collect_oc():
    roots = [
        (HOME / '.openclaw' / 'agents' / 'main' / 'agent' / 'workshop-skills', 'workshop'),
        (HOME / '.openclaw' / 'workspace' / 'skills', 'workspace'),
        (HOME / '.openclaw' / 'plugin-skills', 'plugin'),
        (HOME / '.openclaw' / 'skills', 'agents'),
        (HOME / '.openclaw' / 'mayi2-workspace' / 'skills', 'mayi2'),
        (Path('/opt/homebrew/lib/node_modules/openclaw/skills'), 'bundled'),
    ]
    usage = {}
    db = HOME / '.openclaw' / 'state' / 'openclaw.sqlite'
    if db.exists():
        try:
            con = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
            for nm, cnt, last in con.execute(
                    'select skill_name, use_count, last_used_at_ms from skill_usage'):
                usage[nm] = {
                    'use': cnt,
                    'last': datetime.fromtimestamp(last / 1000).strftime('%Y-%m-%d'),
                }
            con.close()
        except Exception:
            pass
    items, seen = [], {}
    for root, src in roots:
        if not root.is_dir():
            continue
        for d in sorted(root.iterdir()):
            sk = d / 'SKILL.md'
            if not sk.exists():
                continue
            name, desc = read_front(sk)
            key = name or d.name
            if key in seen:          # 同名取先出现的（优先级更高）
                continue
            u = usage.get(key, {})
            rec = {
                'key': key,
                'name': key,
                'src': src,
                'use': u.get('use', 0),
                'last': u.get('last', ''),
                'brief': brief(desc),
                'disabled': False,
                'mtime': mtime_date(d),
                '_desc': desc,
            }
            seen[key] = rec
            items.append(rec)
    # 标记 openclaw.json 里 enabled:false 的内置技能
    cfg = HOME / '.openclaw' / 'openclaw.json'
    if cfg.exists():
        try:
            entries = json.loads(cfg.read_text()).get('skills', {}).get('entries', {})
            off = {k for k, v in entries.items() if v.get('enabled') is False}
            for it in items:
                if it['key'] in off:
                    it['disabled'] = True
        except Exception:
            pass
    return items


# ---------- Codex ----------
def collect_cx():
    base = HOME / '.codex' / 'skills'
    items = []
    if not base.is_dir():
        return items
    for d in sorted(base.iterdir()):
        sk = d / 'SKILL.md'
        if not sk.exists():
            continue
        name, desc = read_front(sk)
        items.append({
            'key': name or d.name,
            'name': name or d.name,
            'use': 0,
            'last': '',
            'brief': brief(desc),
            'mtime': mtime_date(d),
            '_desc': desc,
        })
    return items


# ---------- 双份比对 ----------
def collect_dupes():
    shared = HOME / '.agents' / 'skills'
    wb = HOME / '.workbuddy' / 'skills'
    out = []
    if not shared.is_dir():
        return out
    for d in sorted(shared.iterdir()):
        if not (d / 'SKILL.md').exists():
            continue
        twin = wb / d.name
        if not twin.is_dir():
            out.append({'key': d.name, 'hashShared': dir_hash(d)[0],
                        'hashWb': '', 'filesShared': dir_hash(d)[1],
                        'filesWb': 0, 'state': 'only-shared',
                        'mtimeShared': mtime_date(d), 'mtimeWb': '', 'newer': 'shared'})
            continue
        hs, fs_ = dir_hash(d)
        hw, fw = dir_hash(twin)
        ms, mw = mtime_date(d), mtime_date(twin)
        if hs == hw:
            state = 'same'
        else:
            state = 'diff'
        newer = 'wb' if mw > ms else ('shared' if ms > mw else 'equal')
        out.append({'key': d.name, 'hashShared': hs, 'hashWb': hw,
                    'filesShared': fs_, 'filesWb': fw,
                    'state': state, 'mtimeShared': ms, 'mtimeWb': mw,
                    'newer': newer})
    return out


def codex_gap():
    """Codex 常驻层体检：AGENTS.md 大小 + rules 条数。"""
    p = HOME / '.codex' / 'AGENTS.md'
    size = p.stat().st_size if p.exists() else 0
    rules = HOME / '.codex' / 'rules' / 'default.rules'
    cnt = 0
    if rules.exists():
        cnt = len([l for l in rules.read_text().splitlines() if l.strip()])
    sessions = len(list((HOME / '.codex' / 'sessions').rglob('*.jsonl')))
    return {'agentsMdBytes': size, 'ruleCount': cnt, 'sessionCount': sessions}


def collect_schedules():
    """读两端的定时任务，用来判断哪些技能是真·自动在跑。"""
    jobs = []
    db = HOME / '.workbuddy' / 'workbuddy.db'
    if db.exists():
        try:
            con = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
            for name, status, rrule, prompt in con.execute(
                    'select name, status, rrule, prompt from automations'):
                jobs.append({
                    'app': 'wb', 'name': name, 'on': status == 'ACTIVE',
                    'when': human_rrule(rrule or ''),
                    'text': prompt or '',
                })
            con.close()
        except Exception:
            pass
    odb = HOME / '.openclaw' / 'state' / 'openclaw.sqlite'
    if odb.exists():
        try:
            con = sqlite3.connect(f'file:{odb}?mode=ro', uri=True)
            for name, enabled, blob in con.execute(
                    'select name, enabled, job_json from cron_jobs'):
                try:
                    jd = json.loads(blob)
                except Exception:
                    jd = {}
                # declarationKey 非空 = 系统托管任务，不关联用户技能
                if jd.get('declarationKey') or name.startswith('heartbeat'):
                    continue
                jobs.append({
                    'app': 'oc', 'name': name, 'on': bool(enabled),
                    'when': '', 'text': blob or '',
                })
            con.close()
        except Exception:
            pass
    return jobs


def human_rrule(r):
    """把 RRULE 翻成人话。"""
    if not r:
        return ''
    d = dict(kv.split('=', 1) for kv in r.split(';') if '=' in kv)
    h = d.get('BYHOUR', '').zfill(2) if d.get('BYHOUR') else ''
    m = d.get('BYMINUTE', '00').zfill(2) if d.get('BYMINUTE') else '00'
    t = f'{h}:{m}' if h else ''
    f = d.get('FREQ', '')
    if f == 'DAILY':
        return f'每天 {t}'
    if f == 'WEEKLY':
        days = d.get('BYDAY', '')
        cn = {'MO': '一', 'TU': '二', 'WE': '三', 'TH': '四', 'FR': '五', 'SA': '六', 'SU': '日'}
        ds = ''.join(cn.get(x, x) for x in days.split(','))
        return f'每周{ds} {t}' if days else f'每周 {t}'
    if f == 'HOURLY':
        iv = d.get('INTERVAL', '1')
        return f'每 {iv} 小时'
    if f == 'MONTHLY':
        return f'每月 {d.get("BYMONTHDAY", "")} 日 {t}'
    return r


def _claims(txt, key):
    """判断定时任务文本是否真的引用了这个技能（短名只认强信号）。"""
    if f'/skills/{key}/' in txt or f'「{key}」' in txt or f'"{key}"' in txt:
        return True
    if len(key) < 10:
        return False
    for m in re.finditer(re.escape(key), txt):
        seg = txt[max(0, m.start() - 40): m.end() + 40]
        if 'skill' in seg.lower() or '技能' in seg or '「' in seg:
            return True
    return False


def mark_triggers(items, jobs):
    """判定「要不要你点名」：
       auto  = 说话就行，description 写清了场景，AI 自己会命中
       named = 建议点名，描述太笼统/纯英文/从没命中过，最好说"用 xxx 技能"
       cmd   = 有斜杠命令，可精确点
       另外 autojob 标记是否已挂定时任务（那种连说话都不用）。
    """
    for it in items:
        key = it['key']
        d = it.get('_desc') or ''
        zh = bool(re.search(r'[\u4e00-\u9fa5]', d))
        scene = bool(re.search(r'当用户|当需要|时说|时使用|时调用|需要.{0,6}时|Use when|Use this skill|whenever', d, re.I))
        has_cmd = f'/{key}' in d

        score = 0
        if zh:
            score += 2
        if scene:
            score += 3
        if len(d) >= 80:
            score += 1
        if re.search(r'触发|关键词|/\(?[a-z]', d):
            score += 1
        if not zh and not scene:
            score -= 3
        if it['use'] >= 2:
            score += 2

        if has_cmd:
            it['trigger'] = 'cmd'
        elif score >= 5:
            it['trigger'] = 'auto'
        else:
            it['trigger'] = 'named'
        it['cmd'] = f'/{key}' if has_cmd else ''
        it['score'] = score

        job = None
        for j in jobs:
            if _claims(j['text'], key):
                if job is None or (j['on'] and not job['on']):
                    job = j
        it['autojob'] = bool(job and job['on'])
        it['jobOff'] = bool(job and not job['on'])
        it['when'] = job['when'] if job else ''
        it['jobName'] = job['name'] if job else ''


def main():
    wb, oc, cx = collect_wb(), collect_oc(), collect_cx()
    for group in (wb, oc, cx):
        for it in group:
            if it['key'] in OVERRIDES:
                it['brief'] = OVERRIDES[it['key']]
    jobs = collect_schedules()
    for group in (wb, oc, cx):
        mark_triggers(group, jobs)
        for it in group:
            it.pop('_desc', None)
    dupes = collect_dupes()

    def stats(items):
        live = [i for i in items if i['use'] > 0]
        return {
            'total': len(items),
            'used': len(live),
            'never': len(items) - len(live),
            'calls': sum(i['use'] for i in items),
        }

    data = {
        'generatedAt': NOW.astimezone().strftime('%Y-%m-%d %H:%M'),
        'wb': {'items': wb, 'stats': stats(wb)},
        'oc': {'items': oc, 'stats': stats(oc)},
        'cx': {'items': cx, 'stats': stats(cx)},
        'dupes': dupes,
        'codexGap': codex_gap(),
        'jobs': jobs,
    }
    import sys
    out = None
    if '--out' in sys.argv:
        i = sys.argv.index('--out')
        if i + 1 < len(sys.argv):
            out = Path(sys.argv[i + 1]).expanduser().resolve()
    if out is None:
        out = Path(__file__).resolve().parent.parent / 'design' / 'capability-data.json'
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding='utf-8')
    print(f'-> {out}')
    for k in ('wb', 'oc', 'cx'):
        s = data[k]['stats']
        print(f'{k:3} total={s["total"]:4} used={s["used"]:3} never={s["never"]:4} calls={s["calls"]}')
    print('dupes:', len(dupes), 'diff:', sum(1 for d in dupes if d['state'] == 'diff'))
    print('codexGap:', data['codexGap'])


if __name__ == '__main__':
    main()

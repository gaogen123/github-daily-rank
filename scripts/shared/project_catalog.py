"""Shared StarRocks connection and complete, case-insensitive project inventory."""
import json
import os
from pathlib import Path
import tempfile

import pymysql

ROOT = Path(__file__).resolve().parents[2]


def load_environment():
    path = ROOT / '.env.local'
    if path.exists():
        for line in path.read_text(encoding='utf-8').splitlines():
            key, sep, value = line.strip().partition('=')
            if sep and key and not key.startswith('#'):
                os.environ.setdefault(key.strip(), value.strip().strip('\"\''))


def connect():
    return pymysql.connect(
        host=os.environ.get('STARROCKS_MYSQL_HOST', '127.0.0.1'),
        port=int(os.environ.get('STARROCKS_MYSQL_PORT', '9030')),
        user=os.environ.get('STARROCKS_USER', 'root'),
        password=os.environ.get('STARROCKS_PASSWORD', ''),
        cursorclass=pymysql.cursors.DictCursor, autocommit=True,
        connect_timeout=10, read_timeout=120, write_timeout=120,
    )


SOURCE_TABLES = (
    'ods.ods_repo_github_daily_rank_f_1d',
    'ods.ods_repo_github_weekly_rank_f_1w',
    'ods.ods_repo_github_monthly_rank_f_1m',
    'ods.ods_crawl_day_github_trending_f_1d',
    'ods.ods_crawl_week_github_trending_f_1d',
    'ods.ods_crawl_mon_github_trending_f_1d',
    'dwd.dwd_github_trend_repo_f_1d',
    'ads.ads_github_trend_repo_f',
    'dwd.dwd_github_repo_metrics_f_1d',
)


def query(connection, sql, args=None):
    with connection.cursor() as cursor:
        cursor.execute(sql, args)
        return cursor.fetchall()


def is_unknown_table(error):
    message = str(error.args[1] if len(error.args) > 1 else error)
    return error.args[0] == 1146 or (
        error.args[0] == 5502 and 'Unknown table' in message
    )


def optional_table(connection, table):
    # Only an absent table is optional. Authentication/network/schema errors must surface.
    try:
        return query(connection, f'SELECT * FROM {table}')
    except pymysql.MySQLError as error:
        if is_unknown_table(error):
            return []
        raise


def catalog_from_rows(rows):
    projects = {}
    for row in sorted(rows, key=lambda r: (str(r.get('dt') or ''), r.get('_priority', 0))):
        repo = str(row.get('full_name') or row.get('repo') or '').strip().lower()
        if '/' not in repo:
            continue
        current = projects.get(repo, {'repo': repo, 'name': '', 'description': '', 'stars': 0})
        date = str(row.get('dt') or '')
        first = str(row.get('_first_dt') or row.get('dt') or '')
        if len(first) == 8 and first.isdigit():
            first = f'{first[:4]}-{first[4:6]}-{first[6:]}'
        if len(date) == 8 and date.isdigit():
            date = f'{date[:4]}-{date[4:6]}-{date[6:]}'
        for target, keys in {
            'name': ('repo_name',), 'description': ('description',),
            'url': ('repo_url', 'github_url'), 'topics': ('topics',),
            'language': ('language',), 'repoId': ('repo_id',),
            'openedAt': ('opened_at', 'created_at'),
        }.items():
            value = next((row[k] for k in keys if row.get(k) not in (None, '')), None)
            if value is not None:
                current[target] = value.isoformat()[:10] if hasattr(value, 'isoformat') else value
        stars = next((row[k] for k in ('stargazers_count', 'total_stars', 'stars') if row.get(k) is not None), None)
        if stars is not None:
            current['stars'] = int(stars)
        if date:
            current['firstSeen'] = min(current.get('firstSeen') or first, first)
            current['lastSeen'] = max(current.get('lastSeen') or date, date)
        current.setdefault('url', f'https://github.com/{repo}')
        projects[repo] = current
    return projects


def load_catalog(connection):
    rows = []
    for priority, table in enumerate(SOURCE_TABLES):
        key = 'repo' if 'metrics' in table else 'full_name'
        if 'metrics' in table:
            fields = 'dt, repo, github_url, description, stars, created_at'
        elif table.startswith(('dwd.', 'ads.')):
            fields = 'dt, full_name, repo_url, repo_name, description, stargazers_count, created_at, topics, language, repo_id'
        elif 'ods_repo_' in table:
            fields = 'dt, full_name, repo_url, repo_name, description, total_stars, opened_at'
        else:
            fields = 'dt, full_name, repo_url, description, total_stars, language'
        # Collapse snapshots and avoid loading large raw_json columns.
        sql = f'''SELECT * FROM (
            SELECT {fields}, MIN(dt) OVER (PARTITION BY LOWER({key})) AS _first_dt, ROW_NUMBER() OVER (PARTITION BY LOWER({key}) ORDER BY dt DESC) AS _rn
            FROM {table}
        ) latest WHERE _rn = 1'''
        try:
            records = query(connection, sql)
        except pymysql.MySQLError as error:
            if not is_unknown_table(error):
                raise
            continue
        rows.extend({**row, '_priority': priority} for row in records)
    return catalog_from_rows(rows)


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    name = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent, delete=False) as out:
            name = out.name
            os.fchmod(out.fileno(), 0o644)  # shared public export must be readable by the web container
            json.dump(value, out, ensure_ascii=False)
            out.write('\n')
        os.replace(name, path)
    finally:
        if name and os.path.exists(name):
            os.unlink(name)

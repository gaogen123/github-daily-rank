"""Batch GitHub repository social preview reads; unknown is distinct from default."""
import json
import time
from datetime import datetime, timezone

import requests

IMAGE_COLUMNS = {
    'open_graph_image_url': 'varchar(4096) NULL',
    'uses_custom_open_graph_image': 'boolean NULL',
    'image_fetched_at': 'datetime NULL',
}


def ensure_image_columns(connection, table):
    with connection.cursor() as cursor:
        cursor.execute(f'DESCRIBE {table}')
        columns = {row['Field'] if isinstance(row, dict) else row[0] for row in cursor.fetchall()}
        missing = [f'ADD COLUMN `{name}` {kind}' for name, kind in IMAGE_COLUMNS.items() if name not in columns]
        if missing:
            cursor.execute(f'ALTER TABLE {table} ' + ', '.join(missing))


def decode_batch(payload, names):
    errors = payload.get('errors', [])
    if any(error.get('type') != 'NOT_FOUND' for error in errors):
        raise RuntimeError('GitHub GraphQL preview query failed: ' + ', '.join(str(e.get('type', 'UNKNOWN')) for e in errors))
    data = payload.get('data')
    if not isinstance(data, dict):
        raise RuntimeError('GitHub GraphQL preview response has no data')
    result = {}
    for index, name in enumerate(names):
        key = f'r{index}'
        if key not in data:
            raise RuntimeError(f'GitHub preview response missing {name}')
        node = data[key]
        if node is not None:
            if not isinstance(node.get('usesCustomOpenGraphImage'), bool) or not node.get('openGraphImageUrl'):
                raise RuntimeError(f'Incomplete GitHub preview response for {name}')
            result[name] = {
                'open_graph_image_url': node['openGraphImageUrl'],
                'uses_custom_open_graph_image': node['usesCustomOpenGraphImage'],
                'image_fetched_at': datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S'),
            }
    return result


def fetch_previews(names, api, headers):
    if 'Authorization' not in headers:
        raise RuntimeError('GITHUB_TOKEN is required for repository preview collection')
    result = {}
    names = list(dict.fromkeys(names))
    for offset in range(0, len(names), 40):
        batch = names[offset:offset + 40]
        fields = []
        for index, name in enumerate(batch):
            owner, repo = name.split('/', 1)
            fields.append(f'r{index}: repository(owner:{json.dumps(owner)}, name:{json.dumps(repo)}) {{ openGraphImageUrl usesCustomOpenGraphImage }}')
        for attempt in range(3):
            try:
                response = requests.post(api + '/graphql', headers=headers, json={'query': 'query { ' + ' '.join(fields) + ' }'}, timeout=45)
                response.raise_for_status()
                result.update(decode_batch(response.json(), batch))
                break
            except (requests.RequestException, RuntimeError):
                if attempt == 2:
                    raise
                time.sleep(2 ** attempt)
        print(f'展示图查询：{min(offset + 40, len(names))}/{len(names)}', flush=True)
    return result

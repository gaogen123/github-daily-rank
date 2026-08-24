const DEFAULT_MODEL = 'BAAI/bge-m3';
const DEFAULT_COLLECTION = 'github_projects_bge_m3_v1';

function required(name, value) {
  if (!value) throw new Error(`缺少 ${name} 环境变量`);
  return value;
}

export function vectorSearchConfigured(environment = process.env) {
  return Boolean(
    environment.SILICONFLOW_API_KEY
    && environment.QDRANT_URL
    && environment.QDRANT_API_KEY
  );
}

export function vectorSearchConfig(environment = process.env) {
  return {
    siliconFlowKey: required('SILICONFLOW_API_KEY', environment.SILICONFLOW_API_KEY),
    qdrantUrl: required('QDRANT_URL', environment.QDRANT_URL).replace(/\/$/, ''),
    qdrantKey: required('QDRANT_API_KEY', environment.QDRANT_API_KEY),
    collection: environment.QDRANT_COLLECTION || DEFAULT_COLLECTION,
    model: environment.EMBEDDING_MODEL || DEFAULT_MODEL,
    dimension: Number(environment.EMBEDDING_DIMENSION) || 1024
  };
}

export async function embedTexts(texts, { config, dispatcher } = {}) {
  if (!Array.isArray(texts) || !texts.length) return [];
  const settings = config || vectorSearchConfig();
  const response = await fetch('https://api.siliconflow.cn/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${settings.siliconFlowKey}`,
      'Content-Type': 'application/json'
    },
    dispatcher,
    body: JSON.stringify({
      model: settings.model,
      input: texts,
      encoding_format: 'float'
    })
  });

  if (!response.ok) {
    throw new Error(`SiliconFlow Embedding 请求失败：HTTP ${response.status}`);
  }
  const payload = await response.json();
  const vectors = [...(payload.data || [])]
    .sort((left, right) => left.index - right.index)
    .map((item) => item.embedding);
  if (vectors.length !== texts.length) throw new Error('SiliconFlow 返回的向量数量不完整');
  return vectors;
}

async function qdrantRequest(path, { config, dispatcher, method = 'GET', body } = {}) {
  const settings = config || vectorSearchConfig();
  const response = await fetch(`${settings.qdrantUrl}${path}`, {
    method,
    headers: {
      'api-key': settings.qdrantKey,
      'Content-Type': 'application/json'
    },
    dispatcher,
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Qdrant 请求失败：HTTP ${response.status}${detail ? ` - ${detail.slice(0, 240)}` : ''}`);
  }
  if (response.status === 204) return null;
  return response.json();
}

export async function ensureCollection({ config, dispatcher } = {}) {
  const settings = config || vectorSearchConfig();
  const response = await fetch(`${settings.qdrantUrl}/collections/${settings.collection}`, {
    headers: { 'api-key': settings.qdrantKey },
    dispatcher
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`Qdrant Collection 检查失败：HTTP ${response.status}`);
  }

  if (response.status === 404) {
    await qdrantRequest(`/collections/${settings.collection}`, {
      config: settings,
      dispatcher,
      method: 'PUT',
      body: {
        vectors: { size: settings.dimension, distance: 'Cosine' },
        optimizers_config: { default_segment_number: 2 }
      }
    });
  }

  await qdrantRequest(`/collections/${settings.collection}/index?wait=true`, {
    config: settings,
    dispatcher,
    method: 'PUT',
    body: { field_name: 'stars', field_schema: 'integer' }
  });
}

export async function upsertProjects(points, { config, dispatcher } = {}) {
  if (!points.length) return;
  const settings = config || vectorSearchConfig();
  await qdrantRequest(`/collections/${settings.collection}/points?wait=true`, {
    config: settings,
    dispatcher,
    method: 'PUT',
    body: { points }
  });
}

export async function updateProjectPayloads(updates, { config, dispatcher } = {}) {
  if (!updates.length) return;
  const settings = config || vectorSearchConfig();
  await qdrantRequest(`/collections/${settings.collection}/points/batch?wait=true`, {
    config: settings,
    dispatcher,
    method: 'POST',
    body: {
      operations: updates.map(({ id, payload }) => ({
        set_payload: { payload, points: [id] }
      }))
    }
  });
}

export async function searchProjects(query, {
  config,
  dispatcher,
  limit = 50,
  minStars = 0,
  maxStars = 500_000
} = {}) {
  const settings = config || vectorSearchConfig();
  const [vector] = await embedTexts([query], { config: settings, dispatcher });
  const result = await qdrantRequest(`/collections/${settings.collection}/points/search`, {
    config: settings,
    dispatcher,
    method: 'POST',
    body: {
      vector,
      limit,
      with_payload: true,
      score_threshold: 0.2,
      filter: {
        must: [{ key: 'stars', range: { gte: minStars, lte: maxStars } }]
      }
    }
  });

  return (result.result || []).map((item) => ({
    ...item.payload,
    semanticScore: item.score
  }));
}

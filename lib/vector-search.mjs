import { createHash } from 'node:crypto';
import { ProxyAgent } from 'undici';

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

async function embedTexts(texts, { config, dispatcher } = {}) {
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

async function ensureCollection({ config, dispatcher } = {}) {
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

async function upsertProjects(points, { config, dispatcher } = {}) {
  if (!points.length) return;
  const settings = config || vectorSearchConfig();
  await qdrantRequest(`/collections/${settings.collection}/points?wait=true`, {
    config: settings,
    dispatcher,
    method: 'PUT',
    body: { points }
  });
}

async function updateProjectPayloads(updates, { config, dispatcher } = {}) {
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

async function searchVectorIndex({ vector, limit, minStars, maxStars }, { config, dispatcher }) {
  const result = await qdrantRequest(`/collections/${config.collection}/points/search`, {
    config,
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
  return result.result || [];
}

function productionSearchAdapters({ environment, proxyUrl, config, dispatcher }) {
  const settings = config || vectorSearchConfig(environment);
  const requestDispatcher = dispatcher || (proxyUrl ? new ProxyAgent(proxyUrl) : undefined);
  return {
    embeddingAdapter: {
      embed: (texts) => embedTexts(texts, { config: settings, dispatcher: requestDispatcher })
    },
    vectorIndexAdapter: {
      search: (options) => searchVectorIndex(options, {
        config: settings,
        dispatcher: requestDispatcher
      }),
      ensure: () => ensureCollection({ config: settings, dispatcher: requestDispatcher }),
      upsert: (points) => upsertProjects(points, { config: settings, dispatcher: requestDispatcher }),
      updatePayloads: (updates) => updateProjectPayloads(updates, { config: settings, dispatcher: requestDispatcher })
    }
  };
}

export function createSemanticProjectSearch({
  embeddingAdapter,
  vectorIndexAdapter,
  environment = process.env,
  proxyUrl = environment.HTTPS_PROXY || environment.HTTP_PROXY || '',
  dispatcher
} = {}) {
  if (Boolean(embeddingAdapter) !== Boolean(vectorIndexAdapter)) {
    throw new TypeError('语义搜索 adapter 必须成对提供');
  }
  const adapters = embeddingAdapter
    ? { embeddingAdapter, vectorIndexAdapter }
    : productionSearchAdapters({ environment, proxyUrl, dispatcher });
  if (!adapters.embeddingAdapter?.embed || !adapters.vectorIndexAdapter?.search) {
    throw new TypeError('语义搜索需要完整的 adapter');
  }

  const search = async (query, {
    limit = 50,
    minStars = 0,
    maxStars = 500_000
  } = {}) => {
    const [vector] = await adapters.embeddingAdapter.embed([query]);
    if (!vector) throw new Error('Embedding adapter 未返回查询向量');
    const matches = await adapters.vectorIndexAdapter.search({ vector, limit, minStars, maxStars });
    return matches.map((item) => ({
      ...item.payload,
      semanticScore: item.score
    }));
  };

  const createIndexer = (documentProvider) => createProjectIndexSynchronizer({
    documentProvider,
    vectorIndexWriter: productionIndexWriter(adapters)
  });
  return { search, createIndexer };
}



function contentHash(content) {
  return createHash('sha256').update(content).digest('hex');
}

function documentFingerprint(document) {
  const identity = {
    repo: document?.repo || '',
    name: document?.name || '',
    description: document?.description || '',
    readmeSummary: document?.readmeSummary || '',
    topics: Array.isArray(document?.topics) ? document.topics : []
  };
  return contentHash(JSON.stringify(identity));
}

function payloadFingerprint(document) {
  return contentHash(JSON.stringify({
    repo: document?.repo || '',
    url: document?.url || '',
    name: document?.name || '',
    description: document?.readmeSummary || document?.description || '',
    githubDescription: document?.description || '',
    readmeSummary: document?.readmeSummary || '',
    topics: Array.isArray(document?.topics) ? document.topics : [],
    stars: document?.stars,
    dailyGrowth: document?.dailyGrowth,
    openedAt: document?.openedAt,
    firstSeen: document?.firstSeen,
    lastSeen: document?.lastSeen
  }));
}

function sameDocumentFingerprint(previous, next) {
  if (!previous || !next) return false;
  return documentFingerprint(previous) === documentFingerprint(next);
}

function samePayloadFingerprint(previous, next) {
  if (!previous || !next) return false;
  return payloadFingerprint(previous) === payloadFingerprint(next);
}

function pointId(repo) {
  const hash = createHash('sha256').update(repo.toLowerCase()).digest('hex').slice(0, 32);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20)}`;
}

function buildEmbeddingText(document) {
  return [
    `项目名：${document.repo}`,
    document.name ? `名称：${document.name}` : '',
    document.description ? `Description：${document.description}` : '',
    document.readmeSummary ? `README 摘要：${document.readmeSummary}` : '',
    (document.topics || []).length ? `Topic 标签：${document.topics.join('、')}` : ''
  ].filter(Boolean).join('\n');
}

function buildPayload(document) {
  return {
    repo: document.repo,
    url: document.url,
    name: document.name,
    description: document.readmeSummary || document.description,
    githubDescription: document.description,
    readmeSummary: document.readmeSummary,
    topics: document.topics,
    stars: document.stars,
    dailyGrowth: document.dailyGrowth,
    openedAt: document.openedAt,
    firstSeen: document.firstSeen,
    lastSeen: document.lastSeen
  };
}

export function createProjectIndexSynchronizer({
  documentProvider,
  vectorIndexWriter
}) {
  if (!documentProvider?.list) throw new TypeError('索引同步需要 document provider');
  if (!documentProvider?.save) throw new TypeError('索引同步需要可持久化的 document provider');
  if (!vectorIndexWriter) throw new TypeError('索引同步需要 vector index writer');

  async function buildDocument(project) {
    return documentProvider.prepare(project);
  }

  async function sync({ projects, force = false, refresh = false } = {}) {
    const previousByRepo = await documentProvider.list();

    const pendingVectors = [];
    const pendingPayloads = [];

    for (const project of projects) {
      const previous = previousByRepo[project.repo] || null;
      if (force || !previous) {
        const document = await buildDocument(project);
        if (document) pendingVectors.push(document);
        continue;
      }

      const next = await buildDocument(project);
      if (!next) continue;
      if (!sameDocumentFingerprint(previous, next)) pendingVectors.push(next);
      else if (!samePayloadFingerprint(previous, next)) pendingPayloads.push(next);
    }

    if (pendingVectors.length || pendingPayloads.length) {
      await vectorIndexWriter.sync({ vectors: pendingVectors, payloads: pendingPayloads });
      for (const document of [...pendingVectors, ...pendingPayloads]) {
        await documentProvider.save(document);
      }
    }

    return {
      prepared: pendingVectors.length,
      payloadSynced: pendingPayloads.length
    };
  }

  return { sync };
}

function productionIndexWriter({ embeddingAdapter, vectorIndexAdapter }) {
  if (!embeddingAdapter?.embed || !vectorIndexAdapter) {
    throw new TypeError('索引同步需要 embedding adapter 与 vector index adapter');
  }

  return {
    async sync({ vectors, payloads }) {
      await vectorIndexAdapter.ensure();

      if (vectors.length) {
        const embedded = await embeddingAdapter.embed(vectors.map((document) => buildEmbeddingText(document)));
        if (embedded.length !== vectors.length) {
          throw new Error('Embedding 返回数量与待向量化项目数不一致');
        }
        await vectorIndexAdapter.upsert(vectors.map((document, index) => ({
          id: pointId(document.repo),
          vector: embedded[index],
          payload: buildPayload(document)
        })));
      }

      if (payloads.length) {
        await vectorIndexAdapter.updatePayloads(payloads.map((document) => ({
          id: pointId(document.repo),
          payload: buildPayload(document)
        })));
      }
    }
  };
}

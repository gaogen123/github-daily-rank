import { createHash } from 'node:crypto';
import { ProxyAgent } from 'undici';
import { profileFields } from '../src/lib/project-profiles.js';
import { projectRepositoryUrl } from '../src/lib/project-url.js';

const DEFAULT_MODEL = 'BAAI/bge-m3';
const DEFAULT_COLLECTION = 'github_projects_profiles_v1';

function required(name, value) {
  if (!value) throw new Error(`缺少 ${name} 环境变量`);
  return value;
}

export function vectorSearchConfigured(environment = process.env) {
  const hasKey = Boolean(environment.GEMINI_API_KEY || environment.GOOGLE_API_KEY || environment.SILICONFLOW_API_KEY);
  return Boolean(
    hasKey
    && environment.QDRANT_URL
    && environment.QDRANT_API_KEY
  );
}

export function vectorSearchConfig(environment = process.env) {
  const geminiKey = environment.GEMINI_API_KEY || environment.GOOGLE_API_KEY;
  if (geminiKey) {
    return {
      provider: 'gemini',
      apiKey: geminiKey,
      qdrantUrl: required('QDRANT_URL', environment.QDRANT_URL).replace(/\/$/, ''),
      qdrantKey: required('QDRANT_API_KEY', environment.QDRANT_API_KEY),
      collection: environment.QDRANT_COLLECTION || 'github_projects_gemini_v1',
      model: environment.EMBEDDING_MODEL || 'text-embedding-004',
      dimension: Number(environment.EMBEDDING_DIMENSION) || 768
    };
  }

  return {
    provider: 'siliconflow',
    apiKey: required('SILICONFLOW_API_KEY', environment.SILICONFLOW_API_KEY),
    siliconFlowKey: environment.SILICONFLOW_API_KEY,
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

  if (settings.provider === 'gemini') {
    const baseUrl = (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai').replace(/\/$/, '');
    let response;
    for (let attempt = 0; attempt < 5; attempt++) {
      response = await fetch(`${baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${settings.apiKey}`,
          'Content-Type': 'application/json'
        },
        dispatcher,
        body: JSON.stringify({
          model: settings.model,
          input: texts
        })
      });

      if (response.status === 429 && attempt < 4) {
        const delay = (attempt + 1) * 3000;
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      break;
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Gemini Embedding 请求失败：HTTP ${response.status}${detail ? ` - ${detail.slice(0, 240)}` : ''}`);
    }
    const payload = await response.json();
    const vectors = [...(payload.data || [])]
      .sort((left, right) => left.index - right.index)
      .map((item) => item.embedding);
    if (vectors.length !== texts.length) throw new Error('Gemini 返回的向量数量不完整');
    return vectors;
  }

  const response = await fetch('https://api.siliconflow.cn/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${settings.siliconFlowKey || settings.apiKey}`,
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
    const detail = await response.text().catch(() => '');
    throw new Error(`SiliconFlow Embedding 请求失败：HTTP ${response.status}${detail ? ` - ${detail.slice(0, 240)}` : ''}`);
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
  const headers = { 'Content-Type': 'application/json' };
  if (settings.qdrantKey) headers['api-key'] = settings.qdrantKey;

  const response = await fetch(`${settings.qdrantUrl}${path}`, {
    method,
    headers,
    dispatcher,
    body: body ? JSON.stringify(body) : undefined
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Qdrant 请求失败：HTTP ${response.status}${detail ? ` - ${detail.slice(0, 240)}` : ''}`);
  }
  return response.json();
}

async function ensureCollection({ config, dispatcher }) {
  const settings = config || vectorSearchConfig();
  const collectionResponse = await fetch(`${settings.qdrantUrl}/collections/${settings.collection}`, {
    headers: { 'api-key': settings.qdrantKey },
    dispatcher
  });

  if (collectionResponse.status === 404) {
    await qdrantRequest(`/collections/${settings.collection}`, {
      config: settings,
      dispatcher,
      method: 'PUT',
      body: {
        vectors: {
          size: settings.dimension,
          distance: 'Cosine'
        }
      }
    });
  } else if (!collectionResponse.ok) {
    throw new Error(`Qdrant Collection 检查失败：HTTP ${collectionResponse.status}`);
  } else {
    const data = await collectionResponse.json();
    const vectorConfig = data.result?.config?.params?.vectors;
    const currentSize = typeof vectorConfig === 'number' ? vectorConfig : vectorConfig?.size;
    const currentDistance = typeof vectorConfig === 'object' ? vectorConfig?.distance : undefined;
    if (currentSize !== settings.dimension || (currentDistance && currentDistance !== 'Cosine')) {
      throw new Error('Qdrant collection dimensions/distance do not match configured embeddings');
    }
  }

  await qdrantRequest(`/collections/${settings.collection}/index?wait=true`, {
    config: settings,
    dispatcher,
    method: 'PUT',
    body: {
      field_name: 'stars',
      field_schema: 'integer'
    }
  }).catch(() => null);
}

async function upsertProjects(points, { config, dispatcher }) {
  await qdrantRequest(`/collections/${config.collection}/points?wait=true`, {
    config,
    dispatcher,
    method: 'PUT',
    body: { points }
  });
}

async function updateProjectPayloads(updates, { config, dispatcher }) {
  await qdrantRequest(`/collections/${config.collection}/points/batch?wait=true`, {
    config,
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
        must: [
          {
            key: 'stars',
            range: maxStars == null ? { gte: minStars } : { gte: minStars, lte: maxStars }
          }
        ]
      }
    }
  });
  return result.result || [];
}

function productionSearchAdapters({ environment, proxyUrl, config, dispatcher }) {
  const settings = config || vectorSearchConfig(environment);
  const requestDispatcher = dispatcher || (proxyUrl ? new ProxyAgent(proxyUrl) : undefined);
  return {
    config: settings,
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
    ? { embeddingAdapter, vectorIndexAdapter, config: null }
    : productionSearchAdapters({ environment, proxyUrl, dispatcher });
  if (!adapters.embeddingAdapter?.embed || !adapters.vectorIndexAdapter?.search) {
    throw new TypeError('语义搜索需要完整的 adapter');
  }

  const search = async (query, {
    limit = 50,
    minStars = 0,
    maxStars = null
  } = {}) => {
    const [vector] = await adapters.embeddingAdapter.embed([query]);
    if (!vector) throw new Error('Embedding adapter 未返回查询向量');
    const matches = await adapters.vectorIndexAdapter.search({ vector, limit, minStars, maxStars });
    return matches.map((item) => {
      const project = { ...item.payload };
      return {
        ...project,
        url: projectRepositoryUrl(project),
        semanticScore: item.score
      };
    });
  };

  const createIndexer = (options = {}) => {
    const documentProvider = options.documentProvider || options;
    const batchSize = options.batchSize || 32;
    const vectorIndexWriter = {
      async sync({ vectors, payloads }) {
        await adapters.vectorIndexAdapter.ensure();
        if (vectors.length) {
          const texts = vectors.map((item) => buildEmbeddingText(item));
          const embedded = await adapters.embeddingAdapter.embed(texts);
          if (embedded.length !== vectors.length) throw new Error('生成的 Embedding 数量不完整');
          const points = vectors.map((item, index) => ({
            id: pointId(item.repo),
            vector: embedded[index],
            payload: buildPayload(item)
          }));
          await adapters.vectorIndexAdapter.upsert(points);
        }

        if (payloads.length) {
          const updates = payloads.map((item) => ({
            id: pointId(item.repo),
            payload: buildPayload(item)
          }));
          await adapters.vectorIndexAdapter.updatePayloads(updates);
        }
      }
    };

    return createProjectIndexSynchronizer({
      documentProvider,
      vectorIndexWriter,
      batchSize
    });
  };

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
    summary: document?.summary || '',
    capabilities: document?.capabilities || [],
    features: document?.features || [],
    useCases: document?.useCases || [],
    keywords: document?.keywords || [],
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
    lastSeen: document?.lastSeen,
    profileUpdatedAt: document?.profileUpdatedAt || null
  }));
}

function sameDocumentFingerprint(previous, next) {
  if (!previous || !next) return false;
  const prevFingerprint = previous.contentFingerprint || documentFingerprint(previous);
  const nextFingerprint = next.contentFingerprint || documentFingerprint(next);
  return prevFingerprint === nextFingerprint;
}

function samePayloadFingerprint(previous, next) {
  if (!previous || !next) return false;
  const prevFingerprint = previous.payloadFingerprint || payloadFingerprint(previous);
  const nextFingerprint = next.payloadFingerprint || payloadFingerprint(next);
  return prevFingerprint === nextFingerprint;
}

function pointId(repo) {
  const hash = createHash('sha256').update(repo.toLowerCase()).digest('hex').slice(0, 32);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20)}`;
}

function buildEmbeddingText(document) {
  if (document.embeddingText) return document.embeddingText;
  const parts = [
    `项目名：${document.repo}`,
    document.name ? `名称：${document.name}` : '',
    document.description ? `Description：${document.description}` : '',
    document.summary ? `功能概要：${document.summary}` : (document.readmeSummary ? `README 摘要：${document.readmeSummary}` : ''),
    Array.isArray(document.capabilities) && document.capabilities.length ? `主要功能：${document.capabilities.join('；')}` : '',
    Array.isArray(document.features) && document.features.length ? `技术特点：${document.features.join('；')}` : '',
    Array.isArray(document.useCases) && document.useCases.length ? `适用场景：${document.useCases.join('；')}` : '',
    Array.isArray(document.keywords) && document.keywords.length ? `关键词：${document.keywords.join('、')}` : '',
    (document.topics || []).length ? `Topic 标签：${Array.isArray(document.topics) ? document.topics.join('、') : document.topics}` : ''
  ].filter(Boolean);
  return parts.join('\n');
}

function buildPayload(document) {
  return {
    repo: document.repo,
    url: document.url,
    name: document.name,
    description: document.readmeSummary || document.description,
    githubDescription: document.description,
    readmeSummary: document.readmeSummary,
    ...profileFields(document),
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
  vectorIndexWriter,
  batchSize = 32
} = {}) {
  if (!documentProvider?.list) throw new TypeError('索引同步需要 document provider');
  if (!documentProvider?.save) throw new TypeError('索引同步需要可持续化的 document provider');
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
        if (document) {
          document.contentFingerprint = documentFingerprint(document);
          document.payloadFingerprint = payloadFingerprint(document);
          pendingVectors.push(document);
        }
        continue;
      }

      const next = await buildDocument(project);
      if (!next) continue;
      next.contentFingerprint = documentFingerprint(next);
      next.payloadFingerprint = payloadFingerprint(next);
      if (!sameDocumentFingerprint(previous, next)) pendingVectors.push(next);
      else if (!samePayloadFingerprint(previous, next)) pendingPayloads.push(next);
    }

    if (pendingVectors.length <= batchSize && pendingPayloads.length <= batchSize) {
      if (pendingVectors.length || pendingPayloads.length) {
        await vectorIndexWriter.sync({ vectors: pendingVectors, payloads: pendingPayloads });
        for (const document of [...pendingVectors, ...pendingPayloads]) {
          await documentProvider.save(document);
        }
      }
    } else {
      for (let index = 0; index < pendingVectors.length; index += batchSize) {
        const batch = pendingVectors.slice(index, index + batchSize);
        await vectorIndexWriter.sync({ vectors: batch, payloads: [] });
        for (const document of batch) {
          await documentProvider.save(document);
        }
      }

      for (let index = 0; index < pendingPayloads.length; index += batchSize) {
        const batch = pendingPayloads.slice(index, index + batchSize);
        await vectorIndexWriter.sync({ vectors: [], payloads: batch });
        for (const document of batch) {
          await documentProvider.save(document);
        }
      }
    }

    return {
      prepared: pendingVectors.length,
      payloadSynced: pendingPayloads.length
    };
  }

  return { sync };
}

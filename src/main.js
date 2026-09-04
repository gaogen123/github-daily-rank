import './styles.css';

const tabs = [
  { key: 'dailyGrowth', label: '日增长榜', metric: '日增 Star', help: '按最近一日新增 Star 排序' },
  { key: 'dailyRate', label: '日增速榜', metric: '日增速', help: '日增长量 ÷ 日增长前 Star 数' },
  { key: 'weeklyGrowth', label: '周增长榜', metric: '周增 Star', help: '按最近一周新增 Star 排序' },
  { key: 'weeklyRate', label: '周增速榜', metric: '周增速', help: '周增长量 ÷ 周增长前 Star 数' },
  { key: 'monthlyGrowth', label: '月增长榜', metric: '月增 Star', help: '按最近一月新增 Star 排序' },
  { key: 'monthlyRate', label: '月增速榜', metric: '月增速', help: '月增长量 ÷ 月增长前 Star 数' },
  { key: 'new', label: '新榜', metric: '日增 Star', help: '统计日前 30 天内开源，按日增长排序' },
  { key: 'stars', label: '总榜', metric: '总 Star', help: '按所选当日的累计 Star 数排序' }
];

const newsCategories = [
  { name: 'AI热门', icon: '✦' },
  { name: 'GitHub热门', icon: '★' },
  { name: '后端', icon: '◫' },
  { name: '前端', icon: '◇' },
  { name: 'Android', icon: '◆' },
  { name: 'iOS', icon: '●' },
  { name: 'Web3', icon: '⬡' }
];

const projectCategoryNames = [
  'AI智能体', 'AI编程工具', 'AI开发平台', 'AI运维', 'AI图像工具', 'AI视频工具', 'AI音频工具',
  'AI搜索引擎', 'AI爬虫工具', 'Skills', 'AI营销', 'AI办公工具', 'AI设计工具'
];

const state = {
  data: null,
  activeTab: 'dailyGrowth',
  minK: 1,
  maxK: 500,
  query: '',
  dates: [],
  selectedDate: '',
  dateError: '',
  user: null,
  authError: '',
  globalProjects: null,
  searchResults: null,
  searchMode: false,
  searchProvider: 'keyword',
  searchError: '',
  projectCategories: {},
  projectImages: {},
  projectScores: {},
  directoryCategory: '全部',
  directorySort: 'recommended',
  directoryLimit: 24,
  news: { generated_at: null, count: 0, items: [] },
  newsCategory: 'AI热门',
  newsSort: 'recommended'
};

const numberFormatter = new Intl.NumberFormat('zh-CN');

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character]);
}

function renderDescription(project) {
  const description = project.description || project.name || '暂无项目描述';
  return `<p class="project__description">${escapeHtml(description)}</p>`;
}

function categoriesForRepo(repo) {
  const value = state.projectCategories[repo];
  const categories = Array.isArray(value) ? value : Array.isArray(value?.categories) ? value.categories : [];
  return categories.filter((category) => projectCategoryNames.includes(category));
}

function projectDestination(project) {
  const candidates = [project.homepage, state.projectImages[project.repo]?.homepage, project.url];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const url = new URL(candidate);
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
    } catch {}
  }
  return `https://github.com/${project.repo}`;
}


function renderAuthControl() {
  if (state.user) {
    return `
      <div class="user-menu">
        <a href="${escapeHtml(state.user.profileUrl)}" target="_blank" rel="noreferrer" class="user-menu__profile">
          <img src="${escapeHtml(state.user.avatarUrl)}" alt="" width="30" height="30">
          <span>${escapeHtml(state.user.name)}</span>
        </a>
        <button id="logout-button" type="button">退出</button>
      </div>
    `;
  }

  return `
    <a class="github-login" href="/auth/github">
      <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 .7a11.5 11.5 0 0 0-3.64 22.4c.58.1.79-.25.79-.56v-2.23c-3.22.7-3.9-1.37-3.9-1.37-.52-1.34-1.28-1.7-1.28-1.7-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.57-.3-5.27-1.29-5.27-5.69 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.16 1.18a10.9 10.9 0 0 1 5.76 0c2.2-1.49 3.16-1.18 3.16-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.71 5.39-5.29 5.68.42.36.79 1.07.79 2.16v3.2c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .7Z"/></svg>
      <span>GitHub 登录</span>
    </a>
  `;
}

function metricValue(project, key) {
  if (key === 'new') return project.dailyGrowth;
  return project[key];
}

function metricDisplay(project, key) {
  const value = metricValue(project, key);
  if (key.endsWith('Rate')) return `${value.toFixed(2)}%`;
  return numberFormatter.format(value);
}


function isNewProject(project) {
  if (!project.openedAt) return false;
  const reportDate = new Date(`${state.data.date}T00:00:00Z`);
  const openedAt = new Date(`${project.openedAt}T00:00:00Z`);
  const age = (reportDate - openedAt) / 86_400_000;
  return age >= 0 && age <= 30;
}

function filteredProjects() {
  const min = state.minK * 1_000;
  const max = state.maxK * 1_000;
  const query = state.query.trim().toLowerCase();
  const key = state.searchMode ? 'stars' : state.activeTab === 'new' ? 'dailyGrowth' : state.activeTab;
  const source = state.searchMode
    ? state.searchResults ?? state.globalProjects ?? []
    : state.data.projects;
  const filtered = source
    .filter((project) => project.stars >= min && project.stars <= max)
    .filter((project) => state.searchMode || state.activeTab !== 'new' || isNewProject(project))
    .filter((project) => state.searchProvider === 'semantic' || !query || `${project.repo} ${project.name} ${project.description}`.toLowerCase().includes(query));

  return state.searchMode && state.searchProvider === 'semantic'
    ? filtered
    : filtered.sort((left, right) => right[key] - left[key]);
}

function newsItems() {
  const items = (state.news?.items || [])
    .filter((item) => item.category === state.newsCategory);
  const publishedAt = (item) => {
    const timestamp = Date.parse(item.published_at || '');
    return Number.isNaN(timestamp) ? 0 : timestamp;
  };

  return [...items].sort((left, right) => {
    if (state.newsSort === 'latest') return publishedAt(right) - publishedAt(left);
    return (Number(right.score) || 0) - (Number(left.score) || 0)
      || publishedAt(right) - publishedAt(left);
  });
}

function formatNewsDate(value) {
  if (!value) return '时间未知';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  }).format(date);
}

function formatRelativeNewsDate(value) {
  if (!value) return '时间未知';
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return '时间未知';
  const elapsed = Math.max(0, Date.now() - timestamp);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (elapsed < minute) return '刚刚';
  if (elapsed < hour) return `${Math.floor(elapsed / minute)}分钟前`;
  if (elapsed < day) return `${Math.floor(elapsed / hour)}小时前`;
  if (elapsed < 7 * day) return `${Math.floor(elapsed / day)}天前`;
  if (elapsed < 30 * day) return `${Math.floor(elapsed / (7 * day))}周前`;
  if (elapsed < 365 * day) return `${Math.floor(elapsed / (30 * day))}个月前`;
  return `${Math.floor(elapsed / (365 * day))}年前`;
}


function directoryScore(project) {
  return state.projectScores[project.repo]?.[state.directoryCategory] || null;
}

function directoryProjects() {
  const projects = (state.globalProjects || [])
    .filter((project) => categoriesForRepo(project.repo).length)
    .filter((project) => state.directoryCategory === '全部' || categoriesForRepo(project.repo).includes(state.directoryCategory));

  const scoreDifference = (field, left, right) => {
    const leftScore = directoryScore(left);
    const rightScore = directoryScore(right);
    if (Boolean(leftScore?.excluded) !== Boolean(rightScore?.excluded)) return leftScore?.excluded ? 1 : -1;
    return (Number(rightScore?.[field]) || -1) - (Number(leftScore?.[field]) || -1);
  };
  const comparators = {
    recommended: (left, right) => scoreDifference('comprehensiveScore', left, right),
    rising: (left, right) => scoreDifference('hotScore', left, right),
    hot: (left, right) => (Number(right.dailyGrowth) || 0) - (Number(left.dailyGrowth) || 0),
    popular: (left, right) => (Number(right.stars) || 0) - (Number(left.stars) || 0),
    fastest: (left, right) => (Number(right.dailyRate) || 0) - (Number(left.dailyRate) || 0),
    latest: (left, right) => (Date.parse(right.lastSeen || '') || 0) - (Date.parse(left.lastSeen || '') || 0)
  };

  return projects.sort((left, right) => comparators[state.directorySort](left, right) || left.repo.localeCompare(right.repo));
}

function directoryMetric(project) {
  const score = directoryScore(project);
  const scoreValue = (field) => score ? `${(Number(score[field]) || 0).toFixed(1)} / 100` : '待评分';
  const metrics = {
    recommended: { label: '综合推荐', value: scoreValue('comprehensiveScore') },
    rising: { label: '潜力热度', value: scoreValue('hotScore') },
    hot: { label: '日增 Star', value: `${Number(project.dailyGrowth) >= 0 ? '+' : ''}${numberFormatter.format(Number(project.dailyGrowth) || 0)}` },
    popular: { label: '总 Star', value: numberFormatter.format(Number(project.stars) || 0) },
    fastest: { label: '日增速', value: `${(Number(project.dailyRate) || 0).toFixed(2)}%` },
    latest: { label: '最后收录', value: project.lastSeen || '—' }
  };
  return metrics[state.directorySort];
}

function renderDirectorySection() {
  const projects = directoryProjects();
  const visibleProjects = projects.slice(0, state.directoryLimit);
  const categorizedProjects = (state.globalProjects || []).filter((project) => categoriesForRepo(project.repo).length);
  const categoryCounts = Object.fromEntries(projectCategoryNames.map((category) => [
    category,
    categorizedProjects.filter((project) => categoriesForRepo(project.repo).includes(category)).length
  ]));
  const sortOptions = [
    { key: 'recommended', label: '综合推荐' },
    { key: 'rising', label: '潜力黑马' },
    { key: 'hot', label: '最热' },
    { key: 'popular', label: '最受欢迎' },
    { key: 'fastest', label: '增长最快' },
    { key: 'latest', label: '最新' }
  ];

  return `
    <section class="directory" id="directory" aria-labelledby="directory-title">
      <div class="directory__heading">
        <p class="section-kicker">AI PRODUCT DIRECTORY</p>
        <h2 id="directory-title">AI 产品分类</h2>
        <p>从全库项目中发现按产品能力整理的开源 AI 工具与平台。</p>
      </div>
      <div class="directory-layout">
        <aside class="directory-sidebar" aria-label="产品分类">
          <h3>产品分类</h3>
          <nav>
            ${[{ name: '全部', label: '全部产品', count: categorizedProjects.length }, ...projectCategoryNames.map((category) => ({ name: category, label: category, count: categoryCounts[category] }))].map((category) => `
              <button type="button" data-directory-category="${escapeHtml(category.name)}" class="${state.directoryCategory === category.name ? 'is-active' : ''}" aria-pressed="${state.directoryCategory === category.name}">
                <span>${escapeHtml(category.label)}</span><b>${numberFormatter.format(category.count)}</b>
              </button>
            `).join('')}
          </nav>
        </aside>
        <div class="directory-content">
          <div class="directory-toolbar">
            <div><strong>${escapeHtml(state.directoryCategory === '全部' ? '全部产品' : state.directoryCategory)}</strong><span>${numberFormatter.format(projects.length)} 个项目</span></div>
            <div class="directory-sort" role="group" aria-label="产品排序">
              ${sortOptions.map((option) => `<button type="button" data-directory-sort="${option.key}" class="${state.directorySort === option.key ? 'is-active' : ''}" aria-pressed="${state.directorySort === option.key}">${option.label}</button>`).join('')}
            </div>
          </div>
          ${visibleProjects.length ? `
            <div class="directory-grid">
              ${visibleProjects.map((project) => {
                const categories = categoriesForRepo(project.repo).slice(0, 4);
                const metric = directoryMetric(project);
                const imageUrl = state.projectImages[project.repo]?.url || '/data/project-images/_default.webp';
                const destination = projectDestination(project);
                const score = directoryScore(project);
                const dimensions = score ? [
                  ['增长', score.momentumScore],
                  ['活跃', score.activityScore],
                  ['使用', score.engagementScore],
                  ['质量', score.qualityScore],
                  ['新鲜', score.freshnessScore]
                ] : [];
                const penaltyLabels = {
                  README_TOO_SHORT: 'README 过短',
                  NO_CODE: '未检测到代码',
                  COLLECTION: '资源清单降权',
                  SUSPICIOUS_GROWTH: '异常增长降权',
                  INCOMPLETE_DATA: '部分指标待补齐'
                };
                return `
                  <article class="directory-card ${score?.excluded ? 'is-excluded' : ''}">
                    <a class="directory-card__image" href="${escapeHtml(destination)}" target="_blank" rel="noreferrer" aria-label="查看 ${escapeHtml(project.repo)}">
                      <span aria-hidden="true">${escapeHtml(project.repo)}</span>
                      <img data-directory-image src="${escapeHtml(imageUrl)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">
                    </a>
                    <div class="directory-card__body">
                      <h3><a href="${escapeHtml(destination)}" target="_blank" rel="noreferrer">${escapeHtml(project.repo)} <span aria-hidden="true">↗</span></a></h3>
                      <p>${escapeHtml(project.description || project.name || '暂无项目描述')}</p>
                      <div class="directory-card__tags">${categories.map((category) => `<span>${escapeHtml(category)}</span>`).join('')}</div>
                      <div class="directory-card__stats">
                        <span><small>Star</small><strong>★ ${numberFormatter.format(Number(project.stars) || 0)}</strong></span>
                        <span><small>${escapeHtml(metric.label)}</small><strong>${escapeHtml(metric.value)}</strong></span>
                      </div>
                      ${score ? `
                        <div class="directory-card__scores" aria-label="评分维度">
                          ${dimensions.map(([label, value]) => `<span title="${escapeHtml(label)} ${Number(value).toFixed(1)} 分"><i style="--score:${Math.max(0, Math.min(100, Number(value) || 0))}%"></i><small>${escapeHtml(label)} ${Number(value).toFixed(0)}</small></span>`).join('')}
                        </div>
                        ${score.penalties?.length ? `<div class="directory-card__penalties">${score.penalties.map((penalty) => `<span>${escapeHtml(penaltyLabels[penalty] || penalty)}</span>`).join('')}</div>` : ''}
                      ` : '<div class="directory-card__pending">基础指标尚未采集</div>'}
                      <time datetime="${escapeHtml(project.lastSeen || '')}">最后收录 ${escapeHtml(project.lastSeen || '—')}</time>
                    </div>
                  </article>
                `;
              }).join('')}
            </div>
            <div class="directory-more">
              <span>已展示 ${numberFormatter.format(visibleProjects.length)} / ${numberFormatter.format(projects.length)}</span>
              ${visibleProjects.length < projects.length ? '<button id="directory-load-more" type="button">加载更多</button>' : ''}
            </div>
          ` : '<div class="directory-empty"><strong>该分类暂无项目</strong><span>请选择其他产品分类</span></div>'}
        </div>
      </div>
    </section>
  `;
}

function renderNewsSection() {
  const allItems = state.news?.items || [];
  const items = newsItems();
  const generatedAt = state.news?.generated_at ? formatNewsDate(state.news.generated_at) : '等待首次采集';

  return `
    <section class="news" id="news" aria-labelledby="news-title">
      <div class="news__heading">
        <div>
          <p class="section-kicker">TECH INTELLIGENCE</p>
          <h2 id="news-title">开源与 AI 科技新闻</h2>
          <p>RSSHub 聚合信息源，DeepSeek 提炼中文要点、标签并过滤低价值内容。</p>
        </div>
        <span class="news__updated"><i aria-hidden="true"></i>更新于 ${escapeHtml(generatedAt)}</span>
      </div>
      <div class="news-layout">
        <nav class="news-categories" aria-label="新闻分类">
          ${newsCategories.map((category) => {
            const count = allItems.filter((item) => item.category === category.name).length;
            return `
              <button type="button" data-news-category="${escapeHtml(category.name)}" class="${state.newsCategory === category.name ? 'is-active' : ''}" aria-current="${state.newsCategory === category.name ? 'page' : 'false'}">
                <span class="news-categories__icon" aria-hidden="true">${category.icon}</span>
                <span>${escapeHtml(category.name)}</span>
                <b>${numberFormatter.format(count)}</b>
              </button>
            `;
          }).join('')}
        </nav>
        <div class="news-content">
          <div class="news-toolbar">
            <div><span>当前分类</span><strong>${escapeHtml(state.newsCategory)}</strong><b>${numberFormatter.format(items.length)} 篇</b></div>
            <div class="news-sort" role="group" aria-label="新闻排序">
              <button type="button" data-news-sort="recommended" class="${state.newsSort === 'recommended' ? 'is-active' : ''}" aria-pressed="${state.newsSort === 'recommended'}">推荐</button>
              <button type="button" data-news-sort="latest" class="${state.newsSort === 'latest' ? 'is-active' : ''}" aria-pressed="${state.newsSort === 'latest'}">最新</button>
            </div>
          </div>
          ${items.length ? `
            <div class="news-list">
              ${items.slice(0, 12).map((item) => `
                <article class="news-item">
                  <h3><a href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">${escapeHtml(item.title)} <span aria-hidden="true">↗</span></a></h3>
                  <p class="news-item__tldr">${escapeHtml(item.tldr)}</p>
                  <div class="news-item__footer">
                    <div class="news-item__meta">
                      <span class="news-source">${escapeHtml(item.source?.name || '来源未知')}</span>
                      <time datetime="${escapeHtml(item.published_at || '')}" title="${escapeHtml(formatNewsDate(item.published_at))}">${escapeHtml(formatRelativeNewsDate(item.published_at))}</time>
                    </div>
                    <div class="news-item__tags">${(item.tags || []).slice(0, 3).map((tag) => `<span>${escapeHtml(tag)}</span>`).join('')}</div>
                  </div>
                </article>
              `).join('')}
            </div>
          ` : `
            <div class="news-empty">
              <strong>${allItems.length ? '该分类暂时没有新闻' : '新闻管道已就绪，等待首次采集'}</strong>
              <span>${allItems.length ? '请选择其他分类查看内容' : '配置 DEEPSEEK_API_KEY 后运行 npm run news:refresh'}</span>
            </div>
          `}
        </div>
      </div>
    </section>
  `;
}

function renderTrendPreview(projects) {
  const focusProjects = [...projects]
    .sort((left, right) => right.dailyGrowth - left.dailyGrowth)
    .slice(0, 3);

  return `
    <aside class="trend-preview" aria-label="今日增长焦点">
      <div class="trend-preview__header">
        <div>
          <span>今日增长焦点</span>
          <strong>${state.data.date}</strong>
        </div>
        <div class="trend-preview__pulse" aria-hidden="true">
          <i></i><i></i><i></i><i></i><i></i>
        </div>
      </div>
      <div class="trend-preview__list">
        ${focusProjects.map((project, index) => {
          const owner = project.repo.split('/')[0];
          return `
            <a href="${project.url}" target="_blank" rel="noreferrer" class="trend-project">
              <span class="trend-project__rank">0${index + 1}</span>
              <span class="trend-project__avatar">
                <span aria-hidden="true">${escapeHtml(owner.slice(0, 1).toUpperCase())}</span>
                <img data-avatar src="https://github.com/${encodeURIComponent(owner)}.png?size=72" alt="" width="36" height="36" loading="lazy" decoding="async" referrerpolicy="no-referrer">
              </span>
              <span class="trend-project__name">${escapeHtml(project.repo)}</span>
              <strong>+${numberFormatter.format(project.dailyGrowth)}</strong>
            </a>
          `;
        }).join('')}
      </div>
      <p><span aria-hidden="true"></span>数据来自当前所选日报</p>
    </aside>
  `;
}

function renderApp() {
  const active = state.searchMode
    ? {
        label: state.searchProvider === 'semantic' ? 'Agent 语义搜索' : '关键词搜索',
        help: state.searchProvider === 'semantic'
          ? '基于项目名、Description、README 摘要和 Topic 标签的语义相似度排序'
          : '按项目名和描述匹配历史项目，不调用向量服务'
      }
    : tabs.find((tab) => tab.key === state.activeTab);
  const projects = filteredProjects();

  document.querySelector('#app').innerHTML = `
    <header class="hero">
      <div class="hero__ambient" aria-hidden="true">
        <i></i><i></i><i></i><span></span><span></span><span></span>
        <b>01001010 · 11010011 · ΔSTAR/24H</b>
        <b>SYS.OPEN_SOURCE // RANK.NODE</b>
        <b>0x07F4 001101 24:00 101011</b>
        <b>01 02 03 05 08 13 21 34</b>
      </div>
      <div class="hero__inner">
        <nav class="topbar" aria-label="主导航">
          <a class="brand" href="/" aria-label="GitHub Star 趋势榜首页">
            <span class="brand__mark" aria-hidden="true">★</span>
            <span>GitHub Star 趋势榜</span>
          </a>
          <div class="topbar__actions">
            <div class="topbar__links" aria-label="页面导航">
              <a href="#news">科技新闻</a>
              <a href="#directory">产品分类</a>
              <a href="#ranking-title">趋势榜</a>
            </div>
            ${renderAuthControl()}
          </div>
        </nav>
        ${state.authError ? `<p class="auth-error" role="alert">${escapeHtml(state.authError)}</p>` : ''}
        <div class="hero__content">
          <div class="hero__copy">
            <p class="hero__eyebrow"><i aria-hidden="true"></i> OPEN SOURCE PULSE <span>LIVE</span></p>
            <h1>发现正在快速增长的<br><span>开源项目</span></h1>
            <p class="hero__description">基于每日 GitHub Star 快照，观察项目的短期热度、增长速度与累计影响力。</p>
            <a class="hero__news-link" href="#news"><span>NEW</span> 查看科技新闻 <b>${numberFormatter.format(state.news?.count || state.news?.items?.length || 0)} 条</b> <i aria-hidden="true">↓</i></a>
            <form class="search" id="search-form" role="search">
              <label class="sr-only" for="search-input">搜索项目</label>
              <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m21 21-4.35-4.35m2.35-5.65a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z"/></svg>
              <input id="search-input" value="${escapeHtml(state.query)}" placeholder="搜索项目名称或描述" autocomplete="off">
              <button type="submit" data-search-mode="keyword">搜索</button>
              <button class="search__agent" type="submit" data-search-mode="agent" aria-label="使用 Agent 进行自然语言语义搜索"><span aria-hidden="true">✦</span> Agent 搜索</button>
            </form>
            ${state.searchError ? `<p class="search-error" role="alert">${escapeHtml(state.searchError)}</p>` : ''}
          </div>
          ${renderTrendPreview(state.data.projects)}
        </div>
        <div class="hero__telemetry" aria-label="数据状态">
          <span><i aria-hidden="true"></i> SYSTEM ONLINE</span>
          <span>SNAPSHOT <b>${state.data.date.replaceAll('-', '.')}</b></span>
          <span>RANK NODES <b>${String(state.data.projects.length).padStart(3, '0')}</b></span>
          <span>ARCHIVE <b>${String(state.dates.length).padStart(4, '0')}</b></span>
          <span>UPDATE CYCLE <b>24H</b></span>
        </div>
      </div>
    </header>

    <main>
      ${renderNewsSection()}
      ${renderDirectorySection()}
      <section class="ranking" aria-labelledby="ranking-title">
        <div class="ranking__heading">
          <div>
            <p class="section-kicker">${state.searchMode ? 'ALL PROJECTS' : 'DAILY RANKINGS'}</p>
            <h2 id="ranking-title">${state.searchMode ? '全库项目搜索' : '开源项目排行榜'}</h2>
          </div>
          <form class="filters" id="filter-form">
            ${state.searchMode ? '' : `
              <div class="filters__group filters__group--date">
                <span>统计日期</span>
                <label><span class="sr-only">选择统计日期</span><input class="date-input" name="selectedDate" type="date" min="${state.dates[0]}" max="${state.dates.at(-1)}" value="${state.selectedDate}"></label>
                ${state.dateError ? `<small class="filter-error" role="alert">${escapeHtml(state.dateError)}</small>` : ''}
              </div>
            `}
            <div class="filters__group">
              <span>Star 范围</span>
              <label><span class="sr-only">最小 Star，单位千</span><input name="min" type="number" min="0" step="1" value="${state.minK}"> k</label>
              <span class="filters__separator">—</span>
              <label><span class="sr-only">最大 Star，单位千</span><input name="max" type="number" min="1" step="1" value="${state.maxK}"> k</label>
            </div>
            <button type="submit">筛选</button>
          </form>
        </div>

        ${state.searchMode ? `
          <div class="search-context">
            <div><span>${state.searchProvider === 'semantic' ? 'Agent 搜索 · BGE-M3' : '关键词搜索 · 本地匹配'}</span><strong>“${escapeHtml(state.query)}”</strong></div>
            <button id="clear-search" type="button">返回当日榜单</button>
          </div>
        ` : `
          <div class="tabs" role="tablist" aria-label="榜单类型">
            ${tabs.map((tab) => `
              <button class="tab ${tab.key === state.activeTab ? 'is-active' : ''}" type="button" role="tab" aria-selected="${tab.key === state.activeTab}" data-tab="${tab.key}">${tab.label}</button>
            `).join('')}
          </div>
        `}


        <div class="metric-note">
          <span aria-hidden="true">i</span>
          <p><strong>${active.label}</strong>：${active.help}</p>
          <b>${projects.length} 个结果</b>
        </div>

        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">排名</th>
                <th scope="col">项目</th>
                <th scope="col">总 Star</th>
                <th scope="col">${state.searchProvider === 'semantic' ? '语义匹配' : state.searchMode ? '最后入榜' : active.metric}</th>
                <th scope="col">${state.searchProvider === 'semantic' ? '最后入榜' : state.searchMode ? '首次入榜' : '开源时间'}</th>
              </tr>
            </thead>
            <tbody>
              ${projects.length ? projects.map((project, index) => `
                <tr>
                  <td><span class="rank rank--${index + 1}">${index + 1}</span></td>
                  <td>
                    <div class="project">
                      <span class="project__avatar" role="img" aria-label="${escapeHtml(project.repo.split('/')[0])} 的 GitHub 头像">
                        <span aria-hidden="true">${escapeHtml(project.repo.split('/')[0].slice(0, 1).toUpperCase())}</span>
                        <img data-avatar src="https://github.com/${encodeURIComponent(project.repo.split('/')[0])}.png?size=88" alt="" width="44" height="44" loading="lazy" decoding="async" referrerpolicy="no-referrer">
                      </span>
                      <div>
                        <a href="${project.url}" target="_blank" rel="noreferrer">${escapeHtml(project.repo)} <span aria-hidden="true">↗</span></a>
                        ${renderDescription(project)}
                      </div>
                    </div>
                  </td>
                  <td><span class="stars">★</span> ${numberFormatter.format(project.stars)}</td>
                  <td>${state.searchProvider === 'semantic'
                    ? `<span class="semantic-score">${Math.round((project.semanticScore || 0) * 100)}%</span>`
                    : state.searchMode ? project.lastSeen : `<strong class="growth">${state.activeTab.endsWith('Rate') || metricValue(project, state.activeTab) < 0 ? '' : '+'}${metricDisplay(project, state.activeTab)}</strong>`}</td>
                  <td>${state.searchProvider === 'semantic' ? project.lastSeen : state.searchMode ? project.firstSeen : project.openedAt || '—'}</td>
                </tr>
              `).join('') : `
                <tr><td colspan="5"><div class="empty"><strong>没有符合条件的项目</strong><span>请调整 Star 范围、搜索词或榜单类型</span></div></td></tr>
              `}
            </tbody>
          </table>
        </div>
      </section>
    </main>

    <footer>
      <p>GitHub 榜单来自仓库快照 · 科技新闻由 RSSHub 聚合并经 DeepSeek 辅助编辑</p>
    </footer>
  `;

  bindEvents();
}

function bindEvents() {
  document.querySelectorAll('[data-directory-category]').forEach((button) => {
    button.addEventListener('click', () => {
      state.directoryCategory = button.dataset.directoryCategory;
      state.directoryLimit = 24;
      renderApp();
    });
  });

  document.querySelectorAll('[data-directory-sort]').forEach((button) => {
    button.addEventListener('click', () => {
      state.directorySort = button.dataset.directorySort;
      state.directoryLimit = 24;
      renderApp();
    });
  });

  document.querySelector('#directory-load-more')?.addEventListener('click', () => {
    state.directoryLimit += 24;
    renderApp();
  });

  document.querySelectorAll('[data-news-category]').forEach((button) => {
    button.addEventListener('click', () => {
      state.newsCategory = button.dataset.newsCategory;
      renderApp();
      document.querySelector('#news')?.scrollIntoView({ block: 'start' });
    });
  });

  document.querySelectorAll('[data-news-sort]').forEach((button) => {
    button.addEventListener('click', () => {
      state.newsSort = button.dataset.newsSort;
      renderApp();
      document.querySelector('#news')?.scrollIntoView({ block: 'start' });
    });
  });

  document.querySelector('#logout-button')?.addEventListener('click', async () => {
    const response = await fetch('/api/logout', { method: 'POST' });
    if (response.ok) {
      state.user = null;
      renderApp();
    }
  });

  document.querySelector('#clear-search')?.addEventListener('click', () => {
    state.query = '';
    state.searchResults = null;
    state.searchMode = false;
    state.searchProvider = 'keyword';
    state.searchError = '';
    renderApp();
  });

  document.querySelectorAll('[data-avatar], [data-directory-image]').forEach((image) => {
    const showFallback = () => {
      if (image.matches('[data-directory-image]') && !image.src.endsWith('/data/project-images/_default.webp')) {
        image.src = '/data/project-images/_default.webp';
        return;
      }
      image.parentElement.classList.add('is-error');
    };
    image.addEventListener('error', showFallback);
    if (image.complete && !image.naturalWidth) showFallback();
  });

  document.querySelectorAll('[data-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      state.activeTab = button.dataset.tab;
      renderApp();
    });
  });


  document.querySelector('#filter-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const min = Math.max(0, Number(form.get('min')) || 0);
    const max = Math.max(1, Number(form.get('max')) || 1);
    state.minK = Math.min(min, max);
    state.maxK = Math.max(min, max);
    if (state.searchMode) renderApp();
    else await loadReport(String(form.get('selectedDate')));
  });

  document.querySelector('#search-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const query = document.querySelector('#search-input').value.trim();
    if (!query) {
      state.query = '';
      state.searchResults = null;
      state.searchMode = false;
      state.searchProvider = 'keyword';
      state.searchError = '';
      renderApp();
      return;
    }

    try {
      const searchMode = event.submitter?.dataset.searchMode || 'keyword';
      if (searchMode === 'agent') await performAgentSearch(query);
      else await performKeywordSearch();
      state.query = query;
      state.searchMode = true;
      state.searchError = '';
      renderApp();
      document.querySelector('#ranking-title')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
      state.searchError = error.message;
      renderApp();
    }
  });
}

async function performKeywordSearch() {
  await loadGlobalProjects();
  state.searchResults = null;
  state.searchProvider = 'keyword';
}

async function performAgentSearch(query) {
  const response = await fetch('/api/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, minStars: 0, maxStars: 10_000_000, limit: 100 })
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.message || `Agent 搜索暂时不可用：${response.status}`);
  }
  state.searchResults = (await response.json()).projects;
  state.searchProvider = 'semantic';
}

async function loadGlobalProjects() {
  if (state.globalProjects) return;
  const response = await fetch('/data/projects.json');
  if (!response.ok) throw new Error(`全库项目索引加载失败：${response.status}`);
  state.globalProjects = (await response.json()).projects;
}

async function loadReport(date) {
  if (!state.dates.includes(date)) {
    state.dateError = '该日期没有日报数据，请选择其他日期';
    renderApp();
    return;
  }

  try {
    const response = await fetch(`/data/reports/${date}.json`);
    if (!response.ok) throw new Error(`数据请求失败：${response.status}`);
    state.data = await response.json();
    state.selectedDate = date;
    state.dateError = '';
    renderApp();
  } catch (error) {
    state.dateError = error.message;
    renderApp();
  }
}

async function bootstrap() {
  try {
    const [response, authResponse, newsResponse, projectCategories, projectsResponse, projectImages, projectScores] = await Promise.all([
      fetch('/data/dates.json'),
      fetch('/api/me').catch(() => null),
      fetch('/data/news.json').catch(() => null),
      fetch('/data/project-categories.json')
        .then((categoryResponse) => categoryResponse.ok ? categoryResponse.json() : null)
        .catch(() => null),
      fetch('/data/projects.json'),
      fetch('/data/project-images.json')
        .then((imageResponse) => imageResponse.ok ? imageResponse.json() : null)
        .catch(() => null),
      fetch('/data/project-scores.json')
        .then((scoreResponse) => scoreResponse.ok ? scoreResponse.json() : null)
        .catch(() => null)
    ]);
    if (!response.ok) throw new Error(`日期索引请求失败：${response.status}`);
    if (!projectsResponse.ok) throw new Error(`全库项目索引加载失败：${projectsResponse.status}`);
    const [index, globalProjectIndex] = await Promise.all([response.json(), projectsResponse.json()]);
    state.globalProjects = globalProjectIndex.projects || [];
    if (authResponse?.ok) state.user = (await authResponse.json()).user;
    if (newsResponse?.ok) state.news = await newsResponse.json();
    if (projectCategories && typeof projectCategories === 'object') {
      state.projectCategories = projectCategories.projects || projectCategories.projectCategories || projectCategories.categories || projectCategories;
    }
    if (projectImages?.images && typeof projectImages.images === 'object') {
      state.projectImages = projectImages.images;
    }
    if (projectScores?.projects && typeof projectScores.projects === 'object') {
      state.projectScores = projectScores.projects;
    }
    const authError = new URLSearchParams(window.location.search).get('auth_error');
    if (authError) {
      const authMessages = {
        state: 'GitHub 登录验证已失效，请重新登录',
        token: 'GitHub 授权凭据无效，请检查 Client ID 与 Client Secret 是否属于同一个 OAuth App',
        user: 'GitHub 用户信息读取失败，请稍后重试',
        github: 'GitHub 登录请求失败，请检查服务端终端日志'
      };
      state.authError = authMessages[authError] || authMessages.github;
      window.history.replaceState({}, '', window.location.pathname);
    }
    state.dates = index.dates;
    state.selectedDate = index.latest;
    await loadReport(index.latest);
  } catch (error) {
    document.querySelector('#app').innerHTML = `<div class="load-error"><strong>排行榜加载失败</strong><p>${escapeHtml(error.message)}</p><p>请先运行 <code>npm run generate:data</code>。</p></div>`;
  }
}

bootstrap();

// TasteSkill 品牌感与舒适布局规范重构版 v2.1
import { renderProfileDetails } from './lib/project-profiles.js';
import { projectRepositoryUrl } from './lib/project-url.js';
import './styles.css';
import { normalizeAppData } from './lib/normalize-app-data.js';
import { computeNewsItems, computeRankings, rankingBoard, formatNewsDate, formatRelativeNewsDate, categoriesForRepo as computeCategoriesForRepo, directoryScore as computeDirectoryScore, directoryProjects as computeDirectoryProjects } from './lib/project-state.js';

const tabs = [
  { key: 'trending_daily', label: 'Trending 日榜', metric: '日增 Star', help: 'GitHub Trending 日榜，按原榜排名展示' },
  { key: 'trending_weekly', label: 'Trending 周榜', metric: '周增 Star', help: 'GitHub Trending 周榜，按原榜排名展示' },
  { key: 'trending_monthly', label: 'Trending 月榜', metric: '月增 Star', help: 'GitHub Trending 月榜，按原榜排名展示' },
  { key: 'dailyGrowth', label: '日增长榜', metric: '日增 Star', help: '按最近一日新增 Star 排序' },
  { key: 'dailyRate', label: '日增速榜', metric: '日增速', help: '日增长量 ÷ 日增长前 Star 数' },
  { key: 'weeklyGrowth', label: '周增长榜', metric: '周增 Star', help: '按最近一周新增 Star 排序' },
  { key: 'weeklyRate', label: '周增速榜', metric: '周增速', help: '周增长量 ÷ 周增长前 Star 数' },
  { key: 'monthlyGrowth', label: '月增长榜', metric: '月增 Star', help: '按最近一月新增 Star 排序' },
  { key: 'monthlyRate', label: '月增速榜', metric: '月增速', help: '月增长量 ÷ 月增长前 Star 数' },
  { key: 'new', label: '新榜', metric: '日增 Star', help: '统计日前 30 天内开源，按日增长排序' },
  { key: 'stars', label: '总榜', metric: '总 Star', help: '在日增长榜入选项目中，按累计 Star 数排序' }
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
  activeTab: 'trending_daily',
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
  searchMinK: 0,
  searchMaxK: null,
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
  newsSort: 'recommended',
  viewMode: (typeof localStorage !== 'undefined' && localStorage.getItem('rank_view_mode')) || 'comfortable'
};

const numberFormatter = new Intl.NumberFormat('zh-CN');

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character]);
}

function renderDescription(project) {
  const description = (state.searchMode && project.summary) || project.description || project.name || '暂无项目描述';
  return `<p class="project__description">${escapeHtml(description)}</p>${state.searchMode ? renderProfileDetails(project, escapeHtml) : ''}`;
}

function categoriesForRepo(repo) {
  return computeCategoriesForRepo(repo, state.projectCategories, projectCategoryNames);
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
  return projectRepositoryUrl(project);
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
  if (key.startsWith('trending_')) return project.growth;
  if (key === 'new') return project.dailyGrowth;
  return project[key];
}

function metricDisplay(project, key) {
  const value = metricValue(project, key);
  // 若无对应数值则显示标准连字符
  if (value == null) return '-';
  if (key.endsWith('Rate')) return `${value.toFixed(2)}%`;
  return numberFormatter.format(value);
}


function filteredProjects() {
  return computeRankings({
    data: state.data,
    minK: state.searchMode ? state.searchMinK : state.minK,
    maxK: state.searchMode ? state.searchMaxK : state.maxK,
    query: state.query,
    activeTab: state.activeTab,
    searchMode: state.searchMode,
    searchResults: state.searchResults,
    globalProjects: state.globalProjects,
    searchProvider: state.searchProvider
  });
}

function newsItems() {
  return computeNewsItems({ news: state.news, category: state.newsCategory, sort: state.newsSort });
}


function directoryScore(project) {
  return computeDirectoryScore(project, state.projectScores, state.directoryCategory);
}

function directoryProjects() {
  return computeDirectoryProjects({
    globalProjects: state.globalProjects,
    projectCategories: state.projectCategories,
    projectScores: state.projectScores,
    directoryCategory: state.directoryCategory,
    directorySort: state.directorySort,
    projectCategoryNames
  });
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
    latest: { label: '最后收录', value: project.lastSeen || '-' }
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
        <div class="directory__title-block">
          <h2 id="directory-title">AI 产品能力库</h2>
          <p>按实际产品能力整理的开源 AI 工具、框架与平台索引。</p>
        </div>
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
                const customPreview = project.usesCustomOpenGraphImage && /^https:\/\//.test(project.openGraphImageUrl || '');
                const imageUrl = customPreview ? project.openGraphImageUrl : state.projectImages[project.repo]?.url || '/data/project-images/_default.webp';
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
                      ${!customPreview && state.projectImages[project.repo]?.source === 'github-preview' ? `
                        <div class="directory-live-preview">
                          <small>● GitHub Repository</small>
                          <strong>${escapeHtml(project.repo)}</strong>
                          <p>${escapeHtml(project.description || project.name || '暂无项目描述')}</p>
                          <footer>★ ${numberFormatter.format(project.stars)} Star · 数据更新 ${escapeHtml(project.updatedAt || '待更新')}</footer>
                        </div>` : `<img data-directory-image src="${escapeHtml(imageUrl)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">`}
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
                      <time datetime="${escapeHtml(project.updatedAt || '')}" title="最后收录 ${escapeHtml(project.lastSeen || '-')}">数据更新 ${escapeHtml(project.updatedAt || '待更新')}${score?.updatedAt ? ` · 评分 ${escapeHtml(score.updatedAt)}` : ''}</time>
                      <a class="directory-card__github" href="https://github.com/${escapeHtml(project.repo.split('/').map(encodeURIComponent).join('/'))}" target="_blank" rel="noopener noreferrer" aria-label="在 GitHub 查看 ${escapeHtml(project.repo)}">
                        <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 .7a11.5 11.5 0 0 0-3.64 22.4c.58.1.79-.25.79-.56v-2.23c-3.22.7-3.9-1.37-3.9-1.37-.52-1.34-1.28-1.7-1.28-1.7-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.57-.3-5.27-1.29-5.27-5.69 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.16 1.18a10.9 10.9 0 0 1 5.76 0c2.2-1.49 3.16-1.18 3.16-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.71 5.39-5.29 5.68.42.36.79 1.07.79 2.16v3.2c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .7Z"/></svg>
                        <span>GitHub</span><span aria-hidden="true">↗</span>
                      </a>
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

// 渲染开源与 AI 科技情报板块 (双列舒适阅读流)
function renderNewsSection() {
  const allItems = state.news?.items || [];
  const items = newsItems();
  const generatedAt = state.news?.generated_at ? formatNewsDate(state.news.generated_at) : '等待首次采集';

  return `
    <section class="news" id="news" aria-labelledby="news-title">
      <div class="news__heading">
        <div class="news__title-block">
          <h2 id="news-title">开源与 AI 科技情报</h2>
          <p>RSS 多源聚合，DeepSeek 智能提炼中文核心要点并过滤冗余资讯。</p>
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
                <span class="news-categories__name">${escapeHtml(category.name)}</span>
                <b class="news-categories__count">${numberFormatter.format(count)}</b>
              </button>
            `;
          }).join('')}
        </nav>
        <div class="news-content">
          <div class="news-toolbar">
            <div class="news-toolbar__summary">
              <span>当前分类</span>
              <strong>${escapeHtml(state.newsCategory)}</strong>
              <b>${numberFormatter.format(items.length)} 篇</b>
            </div>
            <div class="news-sort" role="group" aria-label="新闻排序">
              <button type="button" data-news-sort="recommended" class="${state.newsSort === 'recommended' ? 'is-active' : ''}" aria-pressed="${state.newsSort === 'recommended'}">推荐</button>
              <button type="button" data-news-sort="latest" class="${state.newsSort === 'latest' ? 'is-active' : ''}" aria-pressed="${state.newsSort === 'latest'}">最新</button>
            </div>
          </div>
          ${items.length ? `
            <div class="news-grid">
              ${items.slice(0, 12).map((item) => `
                <article class="news-item">
                  <header class="news-item__header">
                    <span class="news-source">${escapeHtml(item.source?.name || '科技情报')}</span>
                    <time datetime="${escapeHtml(item.published_at || '')}" title="${escapeHtml(formatNewsDate(item.published_at))}">${escapeHtml(formatRelativeNewsDate(item.published_at))}</time>
                  </header>
                  <h3 class="news-item__title">
                    <a href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">${escapeHtml(item.title)} <span class="external-icon" aria-hidden="true">↗</span></a>
                  </h3>
                  <p class="news-item__tldr">${escapeHtml(item.tldr)}</p>
                  <div class="news-item__footer">
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

// 渲染今日增长焦点 (Today's Spotlight)
function renderTrendPreview(projects, date) {
  const focusProjects = [...projects]
    .sort((left, right) => right.dailyGrowth - left.dailyGrowth)
    .slice(0, 3);

  return `
    <div class="trend-preview" aria-label="今日增长焦点">
      <div class="trend-preview__header">
        <div class="trend-preview__title-wrap">
          <span class="trend-preview__tag">今日飙升焦点</span>
          <strong class="trend-preview__date">${date || '实时追踪'}</strong>
        </div>
        <div class="trend-preview__pulse" aria-hidden="true" title="数据实时同步中">
          <span class="pulse-dot"></span>
        </div>
      </div>
      <div class="trend-preview__list">
        ${focusProjects.map((project, index) => {
          const owner = project.repo.split('/')[0];
          return `
            <a href="${project.url}" target="_blank" rel="noreferrer" class="trend-project" title="${escapeHtml(project.repo)}">
              <span class="trend-project__rank">0${index + 1}</span>
              <span class="trend-project__avatar">
                <span aria-hidden="true">${escapeHtml(owner.slice(0, 1).toUpperCase())}</span>
                <img data-avatar src="https://github.com/${encodeURIComponent(owner)}.png?size=72" alt="" width="36" height="36" loading="lazy" decoding="async" referrerpolicy="no-referrer">
              </span>
              <div class="trend-project__info">
                <span class="trend-project__name">${escapeHtml(project.repo)}</span>
                <small class="trend-project__category">${categoriesForRepo(project.repo)[0] || '开源工具'}</small>
              </div>
              <strong class="trend-project__growth">+${numberFormatter.format(project.dailyGrowth)}</strong>
            </a>
          `;
        }).join('')}
      </div>
      <div class="trend-preview__footer">
        <span class="trend-preview__indicator"></span>
        <span>基于最新 Star 增量统计</span>
      </div>
    </div>
  `;
}

// 渲染横向时间胶囊条 (Timeline Quick Bar)
function renderTimelineQuickBar() {
  if (!state.dates || !state.dates.length) return '';
  // 取最近 7 天统计日期
  const recentDates = state.dates.slice(-7);
  return `
    <div class="timeline-bar" aria-label="快捷日期回溯">
      <div class="timeline-bar__header">
        <span class="timeline-bar__title">快速回溯</span>
      </div>
      <div class="timeline-bar__list">
        ${recentDates.map((date, idx) => {
          const isLatest = idx === recentDates.length - 1;
          const isSelected = date === state.selectedDate;
          const label = isLatest ? '最新' : date.slice(5);
          return `
            <button type="button" class="timeline-pill ${isSelected ? 'is-active' : ''}" data-timeline-date="${date}" title="切换至 ${date} 榜单快照">
              ${isLatest ? '<span class="timeline-pill__indicator"></span>' : ''}
              <span class="timeline-pill__text">${label}</span>
              <span class="timeline-pill__full-date">${date.slice(5)}</span>
            </button>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

// 渲染工作台随动侧边栏 (Workbench Sticky Sidebar)
function renderWorkbenchSidebar(projects, date) {
  // 1. 今日焦点黑马
  const focusHtml = renderTrendPreview(projects, date);

  // 2. 科技速递微脉动
  const pulseItems = newsItems().slice(0, 3);
  const newsHtml = `
    <div class="sidebar-widget sidebar-news">
      <div class="sidebar-widget__header">
        <div class="sidebar-widget__title-wrap">
          <span class="sidebar-widget__badge">科技速递</span>
          <strong>热点微情报</strong>
        </div>
        <a href="#news" class="sidebar-widget__action-link">查看全部 (${state.news?.items?.length || 0}) ↓</a>
      </div>
      <div class="sidebar-news__list">
        ${pulseItems.length ? pulseItems.map((item) => `
          <a href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer" class="sidebar-news__item" title="${escapeHtml(item.title)}">
            <div class="sidebar-news__meta">
              <span class="sidebar-news__source">${escapeHtml(item.source_title || '科技快讯')}</span>
              <time datetime="${escapeHtml(item.published_at)}">${formatRelativeNewsDate(item.published_at)}</time>
            </div>
            <h4 class="sidebar-news__title">${escapeHtml(item.title)}</h4>
          </a>
        `).join('') : '<p class="sidebar-empty">暂无最新动态</p>'}
      </div>
    </div>
  `;

  // 3. 热门分类雷达
  const categorizedProjects = (state.globalProjects || []).filter((project) => categoriesForRepo(project.repo).length);
  const topCategories = projectCategoryNames.slice(0, 6).map((name) => ({
    name,
    count: categorizedProjects.filter((p) => categoriesForRepo(p.repo).includes(name)).length
  }));
  const categoriesHtml = `
    <div class="sidebar-widget sidebar-categories">
      <div class="sidebar-widget__header">
        <div class="sidebar-widget__title-wrap">
          <span class="sidebar-widget__badge">生态雷达</span>
          <strong>核心能力库</strong>
        </div>
        <a href="#directory" class="sidebar-widget__action-link">分类索引 (${categorizedProjects.length}) ↓</a>
      </div>
      <div class="sidebar-categories__grid">
        ${topCategories.map((cat) => `
          <button type="button" class="sidebar-category-pill ${state.directoryCategory === cat.name ? 'is-active' : ''}" data-sidebar-category="${escapeHtml(cat.name)}">
            <span class="sidebar-category-name">${escapeHtml(cat.name)}</span>
            <span class="sidebar-category-count">${cat.count}</span>
          </button>
        `).join('')}
      </div>
    </div>
  `;

  // 4. 数据引擎状态卡片
  const engineHtml = `
    <div class="sidebar-widget sidebar-engine">
      <div class="sidebar-engine__header">
        <span class="sidebar-engine__dot"></span>
        <span>StarRocks 分析引擎就绪</span>
      </div>
      <p class="sidebar-engine__desc">自动化工作流分钟级追踪 Star 脉动，支持多维增速与黑马预测。</p>
      <div class="sidebar-engine__actions">
        <a href="/data/reports/${state.selectedDate || state.data?.date}.json" target="_blank" download class="sidebar-engine__btn">
          <span>导出当日报表 JSON</span>
          <span aria-hidden="true">↓</span>
        </a>
      </div>
    </div>
  `;

  return `
    <aside class="workbench__sidebar" aria-label="侧边看板">
      ${focusHtml}
      ${newsHtml}
      ${categoriesHtml}
      ${engineHtml}
    </aside>
  `;
}

// 渲染整个看板应用的主入口
function renderApp() {
  const active = state.searchMode
    ? {
        label: state.searchProvider === 'semantic' ? '向量搜索' : '关键词搜索',
        help: state.searchProvider === 'semantic'
          ? '按项目功能、特点与适用场景匹配需求，结果按相关性排序'
          : '搜索全部已收录项目的名称、描述、功能与特点'
      }
    : tabs.find((tab) => tab.key === state.activeTab);
  const projects = filteredProjects();

  document.querySelector('#app').innerHTML = `
    <!-- 头部品牌与首屏 Hero -->
    <header class="hero">
      <!-- 极简暗光背景微粒 -->
      <div class="hero__ambient" aria-hidden="true">
        <div class="hero__glow-orb hero__glow-orb--left"></div>
        <div class="hero__glow-orb hero__glow-orb--right"></div>
      </div>

      <div class="hero__inner">
        <!-- 顶部通栏导航 -->
        <nav class="topbar" aria-label="主导航">
          <a class="brand" href="/" aria-label="GitHub Star 趋势榜首页">
            <span class="brand__mark" aria-hidden="true">★</span>
            <span class="brand__name">GitHub Star 趋势榜</span>
          </a>
          <div class="topbar__actions">
            <div class="topbar__links" aria-label="页面导航">
              <a href="#ranking-title">开源榜单</a>
              <a href="#news">科技情报</a>
              <a href="#directory">产品库</a>
            </div>
            ${renderAuthControl()}
          </div>
        </nav>
        ${state.authError ? `<p class="auth-error" role="alert">${escapeHtml(state.authError)}</p>` : ''}

        <!-- 紧凑聚焦的首屏主体 -->
        <div class="hero__content hero__content--compact">
          <div class="hero__copy">
            <div class="hero__pill">
              <span class="hero__pill-dot"></span>
              <span>开源生态每日雷达 · StarRocks 驱动</span>
            </div>
            <h1>追踪开源增长脉搏<br><span class="hero__title-accent">发现正在爆发的技术黑马</span></h1>
            <p class="hero__description">每日多源聚合 GitHub Star 增量数据与科技情报，深度洞察新兴技术与 AI 工具趋势。</p>

            <!-- Raycast 质感搜索框 (支持 ⌘K / / 快捷键) -->
            <form class="search" id="search-form" role="search">
              <label class="sr-only" for="search-input">搜索项目</label>
              <div class="search__icon" aria-hidden="true">
                <svg viewBox="0 0 24 24"><path d="m21 21-4.35-4.35m2.35-5.65a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z"/></svg>
              </div>
              <input id="search-input" value="${escapeHtml(state.query)}" placeholder="搜索项目、技术栈或自然语言描述需求... (按 / 或 ⌘K 随时搜索)" autocomplete="off">
              <div class="search__actions">
                <button type="submit" data-search-mode="keyword" class="search__submit search__submit--keyword">搜索</button>
                <button class="search__submit search__submit--agent" type="submit" data-search-mode="agent" aria-label="使用向量搜索进行自然语言语义匹配">
                  <span aria-hidden="true">✦</span> 向量搜索
                </button>
              </div>
            </form>

            <!-- 快捷探索热门标签 -->
            <div class="hero__tags" aria-label="热门探索">
              <span class="hero__tags-label">热门探索:</span>
              <button type="button" class="quick-tag" data-tag-query="AI Agent">AI Agent</button>
              <button type="button" class="quick-tag" data-tag-query="LLM">大语言模型</button>
              <button type="button" class="quick-tag" data-tag-query="Frontend">前端架构</button>
              <button type="button" class="quick-tag" data-tag-query="DevOps">开发效能</button>
            </div>
            ${state.searchError ? `<p class="search-error" role="alert">${escapeHtml(state.searchError)}</p>` : ''}
          </div>
        </div>

        <!-- 真实数据看板状态条 -->
        <div class="hero__status-bar" aria-label="看板运行状态">
          <div class="status-pill"><span class="status-dot"></span><span>系统就绪</span></div>
          <div class="status-item"><span>快照日期</span><b>${state.data.date.replaceAll('-', '.')}</b></div>
          <div class="status-item"><span>当前入榜</span><b>${projects.length} 个项目</b></div>
          <div class="status-item"><span>历史沉淀</span><b>${String(state.dates.length)} 天</b></div>
          <div class="status-item"><span>调度频率</span><b>24小时自动更新</b></div>
        </div>
      </div>
    </header>

    <!-- 工作台容器：双栏布局 -->
    <main class="workbench-container">
      <div class="workbench">
        <!-- 左侧核心：开源排行榜 -->
        <div class="workbench__main">
          <section class="ranking" aria-labelledby="ranking-title">
            <!-- 横向时间胶囊条 -->
            ${renderTimelineQuickBar()}

            <div class="ranking__heading">
              <div class="ranking__title-block">
                <h2 id="ranking-title">${state.searchMode ? '全库项目搜索' : '开源项目排行榜'}</h2>
                <p>${state.searchMode ? '全网已收录开源项目的综合检索结果' : '按多维增长指标排序的开源项目排行榜单'}</p>
              </div>

              <!-- 右侧控制区：视图切换 + Star 筛选 -->
              <div class="ranking__controls">
                <div class="view-toggle" role="group" aria-label="视图模式切换">
                  <button type="button" class="view-toggle__btn ${state.viewMode === 'comfortable' ? 'is-active' : ''}" data-view-mode="comfortable" title="舒适卡片视图">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>
                    <span>舒适</span>
                  </button>
                  <button type="button" class="view-toggle__btn ${state.viewMode === 'compact' ? 'is-active' : ''}" data-view-mode="compact" title="极客紧凑表格">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="18" x2="21" y2="18"></line></svg>
                    <span>紧凑</span>
                  </button>
                </div>

                <form class="filters" id="filter-form">
                  ${state.searchMode ? '' : `
                    <div class="filters__group filters__group--date">
                      <span>更多日期</span>
                      <label><span class="sr-only">选择统计日期</span><input class="date-input" name="selectedDate" type="date" min="${state.dates[0]}" max="${state.dates.at(-1)}" value="${state.selectedDate}"></label>
                      ${state.dateError ? `<small class="filter-error" role="alert">${escapeHtml(state.dateError)}</small>` : ''}
                    </div>
                  `}
                  <div class="filters__group">
                    <span>Star</span>
                    <label><span class="sr-only">最小 Star，单位千</span><input name="min" type="number" min="0" step="1" value="${state.searchMode ? state.searchMinK : state.minK}"> k</label>
                    <span class="filters__separator">-</span>
                    <label><span class="sr-only">最大 Star，单位千</span><input name="max" type="number" min="0" step="1" placeholder="不限" value="${state.searchMode ? (state.searchMaxK ?? '') : state.maxK}"> k</label>
                  </div>
                  <button type="submit" class="filters__submit">筛选</button>
                </form>
              </div>
            </div>

            ${state.searchMode ? `
              <div class="search-context">
                <div><span>${state.searchProvider === 'semantic' ? '向量搜索' : '关键词搜索 · 本地匹配'}</span><strong>“${escapeHtml(state.query)}”</strong></div>
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
              <span aria-hidden="true" class="metric-note__icon">i</span>
              <p><strong>${active.label}</strong>：${active.help}${state.searchMode ? '' : ` · 统计日期：${rankingBoard(state.data, state.activeTab).date || '当日暂无数据'}`}</p>
              <b class="metric-note__count">${projects.length} 个结果</b>
            </div>

            <div class="table-wrap view-${state.viewMode}">
              <table>
                <thead>
                  <tr>
                    <th scope="col" class="th-rank">排名</th>
                    <th scope="col" class="th-project">项目</th>
                    <th scope="col" class="th-stars">总 Star</th>
                    <th scope="col" class="th-metric">${state.searchProvider === 'semantic' ? '语义匹配' : state.searchMode ? '最后入榜' : active.metric}</th>
                    <th scope="col" class="th-time">${state.searchProvider === 'semantic' ? '最后入榜' : state.searchMode ? '首次入榜' : '开源时间'}</th>
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
                          <div class="project__meta">
                            <a href="${escapeHtml(projectRepositoryUrl(project))}" target="_blank" rel="noreferrer" class="project__title">${escapeHtml(project.repo)} <span class="external-icon" aria-hidden="true">↗</span></a>
                            ${renderDescription(project)}
                          </div>
                        </div>
                      </td>
                      <td class="td-stars"><span class="stars">★</span> ${numberFormatter.format(project.stars)}</td>
                      <td class="td-metric">${state.searchProvider === 'semantic'
                        ? `<span class="semantic-score">${Math.round((project.semanticScore || 0) * 100)}%</span>`
                        : state.searchMode ? escapeHtml(project.lastSeen || '-') : `<strong class="growth">${metricValue(project, state.activeTab) == null || state.activeTab.endsWith('Rate') || metricValue(project, state.activeTab) < 0 ? '' : '+'}${metricDisplay(project, state.activeTab)}</strong>`}</td>
                      <td class="td-time">${escapeHtml((state.searchProvider === 'semantic' ? project.lastSeen : state.searchMode ? project.firstSeen : project.openedAt) || '-')}</td>
                    </tr>
                  `).join('') : `
                    <tr><td colspan="5"><div class="empty"><strong>没有符合条件的项目</strong><span>请调整 Star 范围、搜索词或榜单类型</span></div></td></tr>
                  `}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <!-- 右侧随动栏：今日焦点 + 科技速报 + 分类雷达 + 引擎状态 -->
        ${renderWorkbenchSidebar(rankingBoard(state.data, 'dailyGrowth').projects, rankingBoard(state.data, 'dailyGrowth').date)}
      </div>

      <!-- 深度探索板块 -->
      <div class="deep-dive-sections">
        ${renderNewsSection()}
        ${renderDirectorySection()}
      </div>
    </main>

    <footer>
      <p>GitHub 榜单来自仓库快照 · 科技新闻由 RSSHub 聚合并经 DeepSeek 辅助编辑 · 基于 StarRocks 实时分析</p>
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
    if (state.searchMode) {
      const rawMax = String(form.get('max') || '').trim();
      state.searchMinK = min;
      state.searchMaxK = rawMax === '' ? null : Math.max(min, Number(rawMax) || 0);
      try {
        if (state.searchProvider === 'semantic') await performAgentSearch(state.query);
        state.searchError = '';
      } catch (error) {
        state.searchError = `${error.message}；可使用关键词搜索。`;
      }
      renderApp();
    } else {
      const max = Math.max(1, Number(form.get('max')) || 1);
      state.minK = Math.min(min, max);
      state.maxK = Math.max(min, max);
      await loadReport(String(form.get('selectedDate')));
    }
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

    state.query = query;
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
      state.searchError = `${error.message}；可使用关键词搜索。`;
      renderApp();
    }
  });

  // 绑定快捷探索标签点击事件：点击快速填入关键词并触发搜索
  document.querySelectorAll('[data-tag-query]').forEach((button) => {
    button.addEventListener('click', async () => {
      const tagQuery = button.dataset.tagQuery;
      const searchInput = document.querySelector('#search-input');
      if (searchInput && tagQuery) {
        searchInput.value = tagQuery;
        state.query = tagQuery;
        await performKeywordSearch();
        state.searchMode = true;
        state.searchError = '';
        renderApp();
        document.querySelector('#ranking-title')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });

  // 绑定横向时间胶囊点击事件：点击平滑加载指定日期快照
  document.querySelectorAll('[data-timeline-date]').forEach((button) => {
    button.addEventListener('click', async () => {
      const date = button.dataset.timelineDate;
      if (date && date !== state.selectedDate) {
        await loadReport(date);
      }
    });
  });

  // 绑定视图切换事件 (舒适卡片 vs 极客紧凑表格)
  document.querySelectorAll('[data-view-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      const mode = button.dataset.viewMode;
      if (mode && mode !== state.viewMode) {
        state.viewMode = mode;
        try {
          localStorage.setItem('rank_view_mode', mode);
        } catch {}
        renderApp();
      }
    });
  });

  // 绑定侧边栏分类胶囊点击事件：切换分类并平滑滚动到产品库
  document.querySelectorAll('[data-sidebar-category]').forEach((button) => {
    button.addEventListener('click', () => {
      const category = button.dataset.sidebarCategory;
      if (category) {
        state.directoryCategory = category;
        state.directoryLimit = 24;
        renderApp();
        document.querySelector('#directory')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });
}

// 全局键盘快捷键监听器 (按 / 或 ⌘K 唤醒聚焦搜索框)
if (typeof window !== 'undefined' && !window.__ranking_keys_bound) {
  window.__ranking_keys_bound = true;
  window.addEventListener('keydown', (event) => {
    const isModifier = event.metaKey || event.ctrlKey;
    const isSearchKey = (isModifier && event.key.toLowerCase() === 'k') || (event.key === '/' && !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName));
    if (isSearchKey) {
      event.preventDefault();
      const searchInput = document.querySelector('#search-input');
      if (searchInput) {
        searchInput.focus();
        searchInput.select();
        searchInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    } else if (event.key === 'Escape' && document.activeElement?.id === 'search-input') {
      document.activeElement.blur();
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
    body: JSON.stringify({ query, minStars: state.searchMinK * 1000, maxStars: state.searchMaxK == null ? null : state.searchMaxK * 1000, limit: 100 })
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.message || `向量搜索暂时不可用：${response.status}`);
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
    const [response, authResponse, newsResponse, projectCategories, projectsResponse, projectImages, projectScores, projectProfiles] = await Promise.all([
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
        .catch(() => null),
      fetch('/data/project-profiles.json')
        .then((profileResponse) => profileResponse.ok ? profileResponse.json() : null)
        .catch(() => null)
    ]);
    if (!response.ok) throw new Error(`日期索引请求失败：${response.status}`);
    if (!projectsResponse.ok) throw new Error(`全库项目索引加载失败：${projectsResponse.status}`);
    const [index, globalProjectIndex] = await Promise.all([response.json(), projectsResponse.json()]);
    const normalized = normalizeAppData({
      index,
      globalProjectIndex,
      authUser: authResponse?.ok ? (await authResponse.json()).user : null,
      news: newsResponse?.ok ? await newsResponse.json() : null,
      projectCategories,
      projectImages,
      projectScores,
      projectProfiles
    });
    state.globalProjects = normalized.globalProjects;
    state.user = normalized.user;
    state.news = normalized.news;
    state.projectCategories = normalized.projectCategories;
    state.projectImages = normalized.projectImages;
    state.projectScores = normalized.projectScores;
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
    state.dates = normalized.dates;
    state.selectedDate = normalized.selectedDate;
    await loadReport(normalized.selectedDate);
  } catch (error) {
    document.querySelector('#app').innerHTML = `<div class="load-error"><strong>排行榜加载失败</strong><p>${escapeHtml(error.message)}</p><p>请先运行 <code>npm run generate:data</code>。</p></div>`;
  }
}

bootstrap();

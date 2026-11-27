const main = document.querySelector('main');
const dialog = document.querySelector('#dialog');
const feedback = document.querySelector('#notice');
const wechat = 'https://mp.weixin.qq.com/';
const platforms = {baidu: '百度热搜', weibo: '微博', zhihu: '知乎', toutiao: '今日头条'};
const external = {
  baidu: 'https://top.baidu.com/board?tab=realtime',
  weibo: 'https://s.weibo.com/top/summary',
  zhihu: 'https://www.zhihu.com/hot',
  toutiao: 'https://www.toutiao.com/trending/'
};
let state, currentArticle, activeRoute, dirty = false;
let activeSource = 'fit', notices, refreshing = false, doctor;
const get = id => document.getElementById(id);
function escape(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => (
    {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character]
  ));
}
const articleLink = id => '#article/' + encodeURIComponent(id);
const dateLabel = date => new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric', weekday: 'long'
}).format(new Date(date + 'T00:00:00+08:00'));
const timeLabel = date => date ? date.slice(5, 16).replace('T', ' ') : '';
const link = (label, url, cls = '') =>
  '<a class="' + cls + '" href="' + escape(url) + '" target="_blank" rel="noopener noreferrer">' + escape(label) + '</a>';
const pill = text => '<span class="pill ' + (text === '待审核' ? 'warm' : text === '未标记' ? 'neutral' : '') + '">' + escape(text) + '</span>';

async function request(path, body) {
  const options = body === undefined ? {} : {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-Workbench-Token': state.csrf},
    body: JSON.stringify(body)
  };
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '请求失败，请刷新后重试。');
  return data;
}
function notice(message) {
  feedback.textContent = message;
  clearTimeout(notices);
  notices = setTimeout(() => { feedback.textContent = ''; }, 6500);
}
async function busy(button, label, task) {
  const previous = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try { await task(); }
  catch (error) { notice(error.message); }
  finally {
    button.disabled = false;
    button.textContent = previous;
  }
}
function modal(content, label, submit) {
  const form = get('dialog-form');
  get('dialog-inner').innerHTML = content;
  get('submit').textContent = label;
  get('cancel').disabled = false;
  form.onsubmit = async event => {
    event.preventDefault();
    get('cancel').disabled = true;
    try {
      await busy(get('submit'), '处理中…', async () => {
        await submit(Object.fromEntries(new FormData(form)));
        dialog.close();
      });
    } finally { get('cancel').disabled = false; }
  };
  dialog.oncancel = event => { if (get('submit').disabled) event.preventDefault(); };
  dialog.showModal();
}
get('cancel').onclick = () => dialog.close();
async function reload() { state = await request('/api/state'); }
const head = (title, caption, action = '', date = '') =>
  '<header class="page-head"><div>' + (date ? '<p class="date">' + escape(date) + '</p>' : '') +
  '<h1>' + escape(title) + '</h1>' + (caption ? '<p class="sub">' + escape(caption) + '</p>' : '') +
  '</div>' + action + '</header>';
const newTopic = '<button class="primary" data-new-topic>＋ 新建选题</button>';

function editTopic(seed = {}) {
  modal('<h2>加入选题池</h2>' +
    '<label>选题标题<input required name="title" maxlength="180" value="' + escape(seed.title) + '"></label>' +
    '<label>栏目<select name="category">' + state.categories.map(category => '<option' +
      (category === (seed.categories || [])[0] ? ' selected' : '') + '>' + escape(category) + '</option>').join('') + '</select></label>' +
    '<label>读者可能搜索的问题<input name="question" placeholder="例如：读完一本书，怎么留下一个能用的方法？"></label>' +
    '<label>已有素材或待核的线索<textarea name="notes" maxlength="6000"></textarea></label>' +
    '<label>来源链接<input type="url" name="url" value="' + escape(seed.url) + '"></label>', '保存选题', async form => {
      await request('/api/topic', {...form, source: seed.source || ''});
      await reload();
      notice('已加入选题池');
      if (activeRoute === 'today' || activeRoute === 'topics') render();
    });
}

function stats() {
  const ready = state.articles.filter(item => item.status === '待审核').length;
  const published = state.articles.filter(item => item.published).length;
  return '<div class="stats">' +
    [['选题池', state.topics.filter(item => item.status === '候选').length + state.catalog.filter(item => item.status === '候选').length, 'topics'],
      ['待审核', ready, 'publish'], ['已登记发表', published, 'publish']].map(([title, count, route]) =>
      '<a class="stat" href="#' + route + '"><span>' + title + '</span><strong>' + count + '</strong></a>').join('') + '</div>';
}
function visibleHot() {
  const feeds = state.hot.feeds || {};
  const feedItems = feed => (feed?.items || []).map(item => ({...item, updated: feed.updated}));
  const items = activeSource === 'fit'
    ? Object.values(feeds).flatMap(feedItems).filter(item => item.categories.length).sort((a, b) =>
        Number(b.updated.slice(0, 10) === state.date) - Number(a.updated.slice(0, 10) === state.date) ||
        a.rank - b.rank || b.categories.length - a.categories.length)
    : feedItems(feeds[activeSource]);
  const seen = new Set();
  return items.filter(item => {
    const key = item.title.replace(/[\p{P}\p{Z}]/gu, '') || item.title;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 10);
}
function hotRows() {
  const feeds = state.hot.feeds || {};
  const updated = Object.values(feeds).some(feed => feed.updated.slice(0, 10) === state.date);
  const attempted = state.hot.attempted;
  let stateText = updated ? '按栏目关键词筛选，点标题查看原榜来源。' :
    attempted ? '今日榜单暂未更新，保留可用的旧榜及其采集时间。' : '打开工作台后自动抓取当日榜单。';
  if (state.hot.failed?.length) stateText += ' 暂不可用：' + state.hot.failed.join('、') + '。';
  if (refreshing) stateText = '正在更新榜单…';
  const top = visibleHot();
  return '<div class="panel-head"><h2>热点雷达</h2><button id="refresh" ' + (refreshing ? 'disabled' : '') + '>⟳ 刷新</button></div>' +
    '<div class="tabs" aria-label="热点来源">' + [['fit', '适合选题'], ...Object.entries(platforms)].map(([id, name]) =>
      '<button data-source="' + id + '" aria-pressed="' + (activeSource === id) + '">' + name + '</button>').join('') + '</div>' +
    '<p class="small hot-info">' + escape(stateText) + '</p>' +
    (top.length ? '<ol class="hot-list">' + top.map((item, index) => '<li class="hot-row">' +
      '<span class="rank ' + (index < 3 ? 'top-rank' : '') + '">' + String(item.rank).padStart(2, '0') + '</span>' +
      '<div>' + link(item.title, item.url, 'headline') + '<p class="small">' + escape(item.source) + ' · ' +
      escape(timeLabel(item.updated)) + (item.categories.length ? ' · ' + escape(item.categories.join(' / ')) : '') +
      '</p></div><button class="text-button" data-hot="' + index + '">＋ 选题</button></li>').join('') + '</ol>' :
      '<p class="empty">' + (updated ? '这个筛选下暂无热点，可以切换榜单。' : '当前暂无可显示的热榜。') + '</p>') +
    '<div class="source-links">' + Object.entries(external).map(([key, url]) => link(platforms[key] + ' ↗', url)).join('') + '</div>';
}
function bindHot() {
  const visible = visibleHot();
  document.querySelectorAll('[data-hot]').forEach(button => {
    button.onclick = () => editTopic(visible[Number(button.dataset.hot)]);
  });
  document.querySelectorAll('[data-source]').forEach(button => {
    button.onclick = () => { activeSource = button.dataset.source; redrawHot(); };
  });
  get('refresh').onclick = () => updateHot(true);
}
function redrawHot() {
  if (activeRoute !== 'today' || !get('hot-panel')) return;
  get('hot-panel').innerHTML = hotRows();
  bindHot();
}
async function updateHot(force) {
  if (refreshing) return;
  refreshing = true;
  redrawHot();
  try { state.hot = await request('/api/hot', {force}); }
  catch (error) { notice(error.message); }
  finally { refreshing = false; redrawHot(); }
}
function todayPage() {
  const latest = state.articles[0];
  const topics = state.topics.slice(0, 3);
  main.innerHTML = head('今日工作台', '', newTopic, dateLabel(state.date)) + stats() +
    '<div class="grid"><section id="hot-panel" class="panel"></section><div class="stack">' +
    '<section class="panel"><div class="panel-head"><h2>最近一篇</h2><a class="text-button" href="#articles">文章库 →</a></div>' +
    (latest ? (latest.cover ? '<a href="' + articleLink(latest.id) + '"><img class="latest-media" src="' + escape(latest.cover) + '" alt="文章封面"></a>' : '<br>') +
      pill(latest.status) + '<a class="feature-title" href="' + articleLink(latest.id) + '">' + escape(latest.title) + '</a>' +
      '<p class="small">' + escape(latest.summary || latest.date) + '</p>' : '<p class="empty">选一个题，开始写第一篇。</p>') + '</section>' +
    '<section class="panel pipeline"><div class="panel-head"><h2>最近选题</h2><a class="text-button" href="#topics">查看选题 →</a></div>' +
    (topics.length ? topics.map(topic => '<div class="row-line"><span>' + escape(topic.title) + '</span>' + pill(topic.status) + '</div>').join('')
      : '<p class="empty">还没有新增选题。选题池里有原来的备选题。</p>') + '</section></div></div>';
  redrawHot();
  if (!state.hot.attempted || state.hot.attempted.slice(0, 10) !== state.date) updateHot(false);
}
function topicRow(item, catalog) {
  return '<li class="topic-row"><div><div class="row-title">' + escape(item.title) + '</div><p class="small">' +
    escape([item.category, item.question || item.notes].filter(Boolean).join(' · ')) + '</p>' +
    (item.url ? '<p class="small">' + link((item.source || '来源') + ' ↗', item.url) + '</p>' : '') +
    '</div><div class="actions">' + pill(item.status) +
    ((!catalog || item.status === '候选') ? '<button data-open-topic="' + escape(item.id) + '">' +
      (item.status === '已开稿' ? '查看稿件' : '开稿') + '</button>' : '') +
    '<button class="text-button topic-delete" data-delete-topic="' + escape(item.id) + '" aria-label="' +
    escape('删除选题：' + item.title) + '">删除</button></div></li>';
}
function topicsPage() {
  main.innerHTML = head('选题池', '整理读者问题、真实素材和热点线索。', newTopic) +
    '<div class="stack"><section class="panel"><h2>工作台选题</h2>' +
    (state.topics.length ? '<ul class="plain-list">' + state.topics.map(item => topicRow(item, false)).join('') + '</ul>'
      : '<p class="empty">从热点中收藏，或录入自己的观察。</p>') +
    '</section><section class="panel"><h2>已有选题表</h2>' +
    (state.catalog.length ? '<ul class="plain-list">' + state.catalog.map(item => topicRow(item, true)).join('') + '</ul>'
      : '<p class="empty">没有可显示的选题。</p>') + '</section></div>';
  document.querySelectorAll('[data-open-topic]').forEach(button => {
    button.onclick = () => busy(button, '正在打开…', async () => {
      const item = await request('/api/open', {id: button.dataset.openTopic});
      await reload();
      location.hash = articleLink(item.id);
    });
  });
  main.querySelectorAll('[data-delete-topic]').forEach(button => {
    button.onclick = () => {
      const id = button.dataset.deleteTopic;
      const item = [...state.topics, ...state.catalog].find(topic => topic.id === id);
      modal('<h2>删除选题</h2><p>' + escape(item.title) + '</p>' +
        '<p class="sub">删除后，这条选题会从选题池移除。已开稿的文章仍可在文章库查看。</p>',
        '删除选题', async () => {
          await request('/api/topic/delete', {id});
          await reload();
          if (activeRoute === 'topics') render();
          notice('已删除选题');
        });
    };
  });
}
function libraryRow(item) {
  return '<li class="library-row"><a class="library-info" href="' + articleLink(item.id) + '">' +
    (item.cover ? '<img class="library-thumb" src="' + escape(item.cover) + '" alt="">' : '') +
    '<div><div class="row-title">' + escape(item.title) + '</div><p class="small">' +
    escape([item.date, item.category, item.published ? '已登记正式链接' : item.wechat?.status].filter(Boolean).join(' · ')) +
    '</p></div></a>' + pill(item.status) + '</li>';
}
function articlesPage() {
  main.innerHTML = head('文章库', '按标题或状态查找本地 Markdown 稿件。', newTopic) +
    '<section class="panel"><div class="filters"><input id="filter-text" type="search" placeholder="搜索标题" aria-label="搜索标题">' +
    '<select id="filter-status" aria-label="筛选状态"><option>全部状态</option><option>未标记</option><option>写作中</option><option>待审核</option><option>已发表</option></select></div>' +
    '<div id="article-list"></div></section>';
  const filter = () => {
    const title = get('filter-text').value.trim().toLowerCase();
    const status = get('filter-status').value;
    const items = state.articles.filter(article => article.title.toLowerCase().includes(title) && (status === '全部状态' || status === article.status));
    get('article-list').innerHTML = items.length ? '<ul class="plain-list">' + items.map(libraryRow).join('') + '</ul>' :
      '<p class="empty">没有符合条件的文章。</p>';
  };
  get('filter-text').oninput = filter;
  get('filter-status').onchange = filter;
  filter();
}
function publishPage() {
  const queue = state.articles.filter(item => !item.published && (item.status === '待审核' || item.wechat));
  const done = state.articles.filter(item => item.published);
  main.innerHTML = head('发表台', '审稿、核对微信草稿和登记正式文章链接。', link('打开微信后台 ↗', wechat, 'button primary')) +
    '<div class="stack"><section class="panel"><div class="panel-head"><h2>微信草稿接口</h2><button id="check-draft">检查微信连接</button></div>' +
    '<p id="doctor" class="sub" role="status"></p><div id="public-ip-row" hidden>' +
    '<span id="public-ip" class="sub"></span> <button id="copy-public-ip">复制 IP</button></div>' +
    '</section><section class="panel"><h2>待审核与微信草稿</h2>' +
    (queue.length ? '<ul class="plain-list">' + queue.map(libraryRow).join('') + '</ul>' : '<p class="empty">在文章页标记待审核后，稿件会出现在这里。</p>') +
    '</section><section class="panel"><h2>发表记录</h2>' +
    (done.length ? '<ul class="plain-list">' + done.map(item =>
      '<li class="topic-row"><div><a class="row-title" href="' + articleLink(item.id) + '">' + escape(item.title) + '</a><p class="small">' +
      escape(item.published.date.replace('T', ' ') + ' 北京时间 · 人工登记') + '</p></div>' +
      link('查看微信原文 ↗', item.published.url, 'button') + '</li>').join('') + '</ul>' : '<p class="empty">暂无已登记的发表记录。旧稿可补录正式链接。</p>') +
    '</section></div>';
  const showDoctor = () => {
    if (!get('doctor')) return;
    get('doctor').textContent = doctor
      ? (doctor.draft ? '微信鉴权和草稿箱读取权限已通过。' : doctor.error)
      : '检查公网出口 IP 和微信草稿箱权限。';
    const ip = doctor?.public_ip;
    get('public-ip-row').hidden = !doctor;
    get('copy-public-ip').hidden = !ip;
    get('public-ip').textContent = ip
      ? (doctor.ip_source === 'wechat' ? '微信识别的公网出口 IP：' : '公网出口 IP（ipify 测得，微信出口可能不同）：') + ip
      : '当前未能检测到公网出口 IP。';
  };
  get('check-draft').onclick = () => busy(get('check-draft'), '检查中…', async () => {
    doctor = undefined;
    showDoctor();
    doctor = await request('/api/wechat/check', {});
    showDoctor();
  });
  get('copy-public-ip').onclick = () => busy(get('copy-public-ip'), '复制中…', async () => {
    await navigator.clipboard.writeText(doctor.public_ip);
    notice('已复制公网出口 IP');
  });
  showDoctor();
}
function editorPage(item) {
  const path = encodeURIComponent(item.id);
  const hasBody = Boolean(item.body);
  const bodyImages = item.images.filter(image => image.url !== item.cover);
  const choices = [['title', '标题'], ['author', '作者'], ['summary', '摘要'], ['tags', '标签']];
  main.innerHTML = '<p class="date"><a href="#articles">← 文章库</a>　' + escape(item.date) + '</p>' +
    '<header class="page-head"><div><h1 class="editor-title">' + escape(item.title) + '</h1><div class="sub">' +
    pill(item.status) + ' ' + escape(item.category || '') + '</div></div><div class="actions"><button id="draft-ai" class="primary">用 AI 模型 生成完整稿</button><button id="save">保存稿件</button></div></header>' +
    '<div class="grid editor-layout"><div class="stack">' +
    '<section class="panel"><div class="panel-head"><h2>稿件编辑</h2><span class="small" id="edit-state">已读取本地稿件</span></div>' +
    '<label>标题<input id="title" maxlength="180" value="' + escape(item.title) + '"></label>' +
    '<div class="field-pair"><label>作者<input id="author" value="' + escape(item.author) + '" placeholder="可留空"></label>' +
    '<label>标签<input id="tags" value="' + escape(item.tags) + '" placeholder="英文逗号分隔"></label></div>' +
    '<label>摘要<textarea id="summary" rows="2">' + escape(item.summary) + '</textarea></label>' +
    '<label>正文 Markdown<textarea id="body" placeholder="从一个具体场景或读者问题写起。">' + escape(item.body) + '</textarea></label>' +
    '<details><summary>来源与事实核对</summary><label>来源记录<textarea id="sources" rows="5" placeholder="书名、版本、页码或核对链接。">' +
    escape(item.sources) + '</textarea></label></details></section>' +
    '<section class="panel"><h2>创作助手</h2><label>补充真实素材或本次写作方向<textarea id="direction" maxlength="6000"></textarea></label>' +
    '<div class="actions"><button id="copy-task">复制创作任务</button></div>' +
    '<p class="small hot-info">生成后自动保存标题、摘要、标签和正文，并生成直接粘贴版。调用时会向 AI 模型 提交本稿、素材和近期标题。</p>' +
    '<label id="ai-label" hidden>创作记录<textarea id="ai-result" readonly></textarea></label></section></div>' +
    '<div class="stack"><section class="panel"><div class="panel-head"><h2>正文预览</h2><span class="small">最近保存版本</span></div>' +
    '<div id="article-preview" class="preview-article">' + (hasBody ? item.preview : '<p class="empty">保存正文后显示预览。</p>') + '</div>' +
    (hasBody ? '<div class="copy-actions actions"><button id="copy-body" class="primary">复制排版正文</button>' +
      choices.map(([key, name]) => '<button data-copy="' + key + '">复制' + name + '</button>').join('') + '</div>' : '') +
    '<details><summary>手动选择复制</summary><p class="small">可直接选择上方正文，或从下方字段复制文字。</p>' +
    '<textarea readonly aria-label="手动复制文字">' + escape([item.title, item.author, item.summary, item.tags].join('\n')) + '</textarea></details></section>' +
    '<section class="panel"><div class="panel-head"><h2>封面与正文图</h2>' +
    (item.cover ? '<a class="text-button" href="' + escape(item.cover) + '" target="_blank" rel="noopener">查看原图 ↗</a>' : '') + '</div>' +
    '<div class="cover-previews">' +
    '<div class="cover-card"><p class="small">宽幅卡片</p>' +
    (item.cover ? '<img class="cover-wide" src="' + escape(item.cover) + '" alt="宽幅裁切预览">' : '<div class="cover-wide cover-placeholder">封面待添加</div>') +
    '<p class="cover-title" data-card-title></p><p class="cover-summary small" id="card-summary"></p></div>' +
    '<div class="cover-card cover-chat"><p class="small">聊天卡片</p><div class="cover-chat-row">' +
    '<p class="cover-title" data-card-title></p>' +
    (item.cover ? '<img class="cover-square" src="' + escape(item.cover) + '" alt="方形裁切预览">' : '') +
    '</div></div></div>' +
    '<p class="small hot-info">裁切示意，正式效果以微信后台手机预览为准。</p>' +
    (item.status !== '已发表' && hasBody ? '<div class="actions"><button id="auto-illustrate" class="primary">自动配图并插入</button></div>' +
      '<p class="small">Codex 阅读正文，选位置、配图、写图注并更新直接粘贴版。通常需要几分钟。</p>' : '') +
    (item.status !== '已发表' ? '<div class="actions"><button class="primary" data-generate="cover">生成封面</button><button data-generate="body">生成正文图</button></div>' : '') +
    '<div class="actions"><button data-image="cover">' + (item.cover ? '更换封面' : '添加封面') + '</button><button data-image="body">添加正文图</button></div>' +
    '<input type="file" id="image-input" accept="image/png,image/jpeg,image/gif,image/webp" hidden>' +
    (bodyImages.length ? '<div class="image-list">' + bodyImages.map(image => '<button data-insert="' + escape(image.name) + '" title="插入正文">' +
      '<img src="' + escape(image.url) + '" alt="">' + escape(image.name.split('/').pop()) + '</button>').join('') + '</div>' : '') +
    '<p class="small hot-info">点击图片插入 Markdown，补写图注后保存。</p></section>' +
    '<section class="panel"><h2>审稿与发表</h2>' +
    '<details><summary>编辑检查</summary><ul class="editor-review">' +
    '<li>开头尽早交代具体场景和读者要解决的问题。</li>' +
    '<li>标题提到的判断或做法在正文中有材料、有解释。</li>' +
    '<li>至少有一段值得保存或转给别人，可以是一句判断、一个例子或一个动作。</li>' +
    '<li>核对事实、引文和图源，检查手机首屏与封面裁切。</li>' +
    '</ul></details><div class="actions" style="margin-top:12px">' +
    (item.status !== '已发表' ? '<button id="queue">' + (item.status === '待审核' ? '退回写作' : '标记待审核') + '</button>' : '') +
    '<button id="export">生成直接粘贴版</button>' + (item.has_export ? '<a class="button" href="/export?id=' + path + '">下载已保存版</a>' : '') +
    '</div><div class="actions" style="margin-top:10px">' +
    link('打开微信后台 ↗', wechat, 'button primary') +
    (item.status === '待审核' && !item.wechat ? '<button id="make-draft">创建微信草稿</button>' : '') +
    '<button id="record">' + (item.published ? '更新发表记录' : '登记已发表') + '</button></div>' +
    (item.wechat ? '<p class="small hot-info">微信草稿：' + escape(item.wechat.status) + ' · ' + escape(timeLabel(item.wechat.requested)) + '</p>' : '') +
    (['待核对', '上传中'].includes(item.wechat?.status) ? '<button id="reset-draft" class="text-button">确认后台无稿，清除待核对状态</button>' : '') +
    (item.published ? '<p class="small hot-info">' + link('微信原文 ↗', item.published.url) + ' · ' +
      escape(item.published.date.replace('T', ' ')) + ' · 人工登记</p>' : '') +
    '<p class="small hot-info">后台手机预览后，手动点击发表。工作台可登记最终链接。</p></section></div></div>';

  const fields = ['title', 'author', 'summary', 'tags', 'body', 'sources'];
  const markDirty = () => {
    dirty = true;
    get('edit-state').textContent = '有未保存的修改';
  };
  const cardTitles = main.querySelectorAll('[data-card-title]');
  const cardSummary = get('card-summary');
  const updateCard = () => {
    const caption = get('title').value.trim() || '标题待填写';
    cardTitles.forEach(element => { element.textContent = caption; });
    cardSummary.textContent = get('summary').value.trim();
    cardSummary.hidden = !cardSummary.textContent;
  };
  fields.forEach(field => { get(field).oninput = markDirty; });
  ['title', 'summary'].forEach(field => { get(field).addEventListener('input', updateCard); });
  updateCard();
  const requireSaved = () => { if (dirty) throw new Error('请先保存稿件。'); };
  async function refreshEditor() {
    const viewing = activeRoute === 'article' && currentArticle?.id === item.id;
    await reload();
    if (viewing && activeRoute === 'article' && currentArticle?.id === item.id) {
      currentArticle = await request('/api/article?id=' + path);
      dirty = false;
      editorPage(currentArticle);
    }
  }
  function saveEditor() {
    const raw = Object.fromEntries(fields.map(field => [field, get(field).value]));
    return request('/api/save', {id: item.id, rev: item.rev, ...raw});
  }
  get('save').onclick = () => busy(get('save'), '保存中…', async () => {
    await saveEditor();
    await refreshEditor();
    notice('已保存稿件');
  });
  get('copy-body')?.addEventListener('click', async () => {
    try {
      const parsed = new DOMParser().parseFromString(item.copy, 'text/html');
      await navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([item.copy], {type: 'text/html'}),
        'text/plain': new Blob([parsed.body.textContent], {type: 'text/plain'})
      })]);
      notice('已复制排版正文');
    } catch {
      const range = document.createRange();
      range.selectNodeContents(get('article-preview'));
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      notice('已选择预览正文，按 Command+C 复制');
    }
  });
  document.querySelectorAll('[data-copy]').forEach(button => {
    button.onclick = () => busy(button, '复制中…', async () => {
      const key = button.dataset.copy;
      if (!item[key]) return notice('该字段为空');
      await navigator.clipboard.writeText(item[key]);
      notice('已复制');
    });
  });
  get('copy-task').onclick = () => busy(get('copy-task'), '整理中…', async () => {
    requireSaved();
    const {text} = await request('/api/task', {id: item.id, direction: get('direction').value});
    get('ai-label').hidden = false;
    get('ai-result').value = text;
    try { await navigator.clipboard.writeText(text); notice('已复制，可粘贴到 AI 模型'); }
    catch { get('ai-result').select(); notice('已选择创作任务，按 Command+C 复制'); }
  });
  get('draft-ai').onclick = () => busy(get('draft-ai'), 'AI 模型 写作中…', async () => {
    requireSaved();
    if (item.body && !window.confirm('当前稿件已有正文。保留旧版并生成新稿？')) return;
    const direction = get('direction').value;
    const inputs = fields.map(get);
    inputs.forEach(input => { input.readOnly = true; });
    let result;
    try {
      result = await request('/api/ai', {id: item.id, rev: item.rev, replace: Boolean(item.body), direction});
    } finally {
      inputs.forEach(input => { input.readOnly = false; });
    }
    const {article, text} = result;
    await reload();
    if (activeRoute !== 'article' || currentArticle?.id !== item.id) {
      notice('已保存完整稿及直接粘贴版');
      return;
    }
    currentArticle = article;
    editorPage(article);
    get('direction').value = direction;
    get('ai-label').hidden = false;
    get('ai-result').value = text;
    notice('已保存完整稿及直接粘贴版，请核对正文、来源和配图');
  });
  const insert = name => {
    const body = get('body');
    body.setRangeText('\n\n![正文配图](' + name + ')\n\n*补写图注*\n\n', body.selectionStart, body.selectionEnd, 'end');
    body.focus();
    markDirty();
  };
  document.querySelectorAll('[data-insert]').forEach(button => { button.onclick = () => insert(button.dataset.insert); });
  const autoIllustrate = get('auto-illustrate');
  if (autoIllustrate) autoIllustrate.onclick = () => busy(autoIllustrate, '正在配图并插入…', async () => {
    const locked = fields.map(get);
    locked.forEach(input => { input.readOnly = true; });
    let result;
    let savedDraft = false;
    try {
      const saved = dirty ? await saveEditor() : item;
      savedDraft = saved !== item;
      result = await request('/api/image/auto', {id: item.id, rev: saved.rev});
    } finally {
      locked.forEach(input => { input.readOnly = false; });
      if (get('auto-illustrate') === autoIllustrate && (result || savedDraft)) await refreshEditor();
      else if (result && !dirty) await refreshEditor();
    }
    notice(result.count ? '已插入 ' + result.count + ' 张正文图及图注，直接粘贴版已更新' : '正文已有足量配图，直接粘贴版已更新');
  });
  main.querySelectorAll('[data-generate]').forEach(button => {
    button.onclick = () => {
      if (dirty) return notice('请先保存稿件。');
      const kind = button.dataset.generate;
      const isCover = kind === 'cover';
      const replacesCover = isCover && Boolean(item.cover);
      modal('<h2>' + button.textContent + '</h2>' +
        '<label>画面说明<textarea name="scene" rows="3" maxlength="600" placeholder="可留空。也可以写明要画的场景、构图或正文段落。"></textarea></label>' +
        (replacesCover ? '<p class="small">新图将设为当前封面，原图保留在文章目录。</p>' : '') +
        '<p class="small">Codex 使用标题、摘要和画面说明生成一张插画，保存到本文图片目录。通常需要几分钟。</p>',
        replacesCover ? '生成并更换封面' : '开始生成', async form => {
          requireSaved();
          await request('/api/image/generate', {id: item.id, rev: item.rev, kind, scene: form.scene, replace: replacesCover});
          await refreshEditor();
          notice(isCover ? '已生成并设置封面' : '正文图已保存。将光标放到正文对应位置，再点击图片插入。');
        });
    };
  });
  document.querySelectorAll('[data-image]').forEach(button => {
    button.onclick = () => {
      if (dirty) return notice('请先保存稿件。');
      const input = get('image-input');
      input.dataset.kind = button.dataset.image;
      input.value = '';
      input.click();
    };
  });
  get('image-input').onchange = async event => {
    const input = event.target;
    const file = input.files[0];
    if (!file) return;
    if (file.size > 15_000_000) return notice('请选择 15 MB 以内的图片。');
    const isCover = input.dataset.kind === 'cover';
    try {
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.onerror = () => reject(new Error('无法读取所选图片。'));
        reader.readAsDataURL(file);
      });
      requireSaved();
      const result = await request('/api/image', {id: item.id, name: file.name, cover: isCover, data});
      await refreshEditor();
      if (!isCover && currentArticle?.id === item.id && activeRoute === 'article') {
        const body = get('body');
        body.setSelectionRange(body.value.length, body.value.length);
        insert(result.name);
      }
      notice(isCover ? '已更新封面' : '图片已保存，请补写图注并保存正文');
    } catch (error) { notice(error.message); }
  };
  get('queue')?.addEventListener('click', () => busy(get('queue'), '更新中…', async () => {
    requireSaved();
    await request('/api/status', {id: item.id, status: item.status === '待审核' ? '写作中' : '待审核'});
    await refreshEditor();
  }));
  get('export').onclick = () => busy(get('export'), '生成中…', async () => {
    requireSaved();
    const result = await request('/api/export', {id: item.id});
    await refreshEditor();
    notice('已保存 ' + result.path);
  });
  get('record').onclick = () => {
    if (dirty) return notice('请先保存稿件。');
    modal('<h2>登记正式发表</h2><label>微信文章链接<input type="url" required name="url" value="' +
      escape(item.published?.url) + '"></label><label>实际发表时间（北京时间）<input type="datetime-local" required name="date" value="' +
      escape(item.published?.date) + '"></label>', '登记', async form => {
      await request('/api/status', {id: item.id, status: '已发表', ...form});
      await refreshEditor();
      notice('已登记正式发表');
    });
  };
  get('make-draft')?.addEventListener('click', () => {
    if (dirty) return notice('请先保存稿件。');
    if (!state.wechat_appid) return notice('请先按 README 配置公众号账号。');
    modal('<h2>创建微信草稿</h2><p class="sub">' + escape(item.title) + '</p><p class="sub">将向 AppID ' +
          escape(state.wechat_appid) + ' 对应的公众号上传配图并创建草稿。</p>' +
      '<label><span><input type="checkbox" required name="confirmed"> 我已核对标题、正文和封面</span></label>',
      '创建微信草稿', async form => {
        try {
          await request('/api/draft', {id: item.id, appid: state.wechat_appid, confirmed: form.confirmed === 'on'});
          notice('已创建微信草稿');
        } finally { await refreshEditor(); }
      });
  });
  get('reset-draft')?.addEventListener('click', () => {
    if (dirty) return notice('请先保存稿件。');
    modal('<h2>核对微信草稿</h2><label><span><input type="checkbox" required name="confirmed"> 我已查看后台，未找到这篇文章的草稿</span></label>',
      '清除待核对状态', async form => {
        await request('/api/draft/reset', {id: item.id, confirmed: form.confirmed === 'on'});
        await refreshEditor();
      });
  });
}

function render() {
  if (activeRoute === 'today') todayPage();
  if (activeRoute === 'topics') topicsPage();
  if (activeRoute === 'articles') articlesPage();
  if (activeRoute === 'publish') publishPage();
  if (activeRoute === 'article' && currentArticle) editorPage(currentArticle);
  document.querySelectorAll('[data-new-topic]').forEach(button => { button.onclick = () => editTopic(); });
}
let savedHash = '';
let routeRequest = 0;
async function route() {
  if (!state) return;
  const hash = location.hash;
  if (dirty && hash !== savedHash && !window.confirm('稿件有未保存的修改，离开当前页？')) {
    history.replaceState(null, '', savedHash);
    return;
  }
  const requestId = ++routeRequest;
  savedHash = hash;
  dirty = false;
  const requested = hash.slice(1).split('/')[0];
  activeRoute = ['today', 'topics', 'articles', 'publish', 'article'].includes(requested) ? requested : 'today';
  document.querySelectorAll('[data-nav]').forEach(link => {
    if (link.dataset.nav === (activeRoute === 'article' ? 'articles' : activeRoute)) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  try {
    if (activeRoute === 'article') {
      main.innerHTML = '<p class="loading">正在读取稿件…</p>';
      const requestedArticle = await request('/api/article?id=' + hash.slice('#article/'.length));
      if (requestId !== routeRequest) return;
      currentArticle = requestedArticle;
    }
    render();
    window.scrollTo(0, 0);
  } catch (error) {
    if (requestId === routeRequest) main.innerHTML = '<p class="empty">' + escape(error.message) + ' <a href="#articles">返回文章库</a></p>';
  }
}
window.addEventListener('hashchange', route);
window.addEventListener('beforeunload', event => {
  if (dirty) { event.preventDefault(); event.returnValue = ''; }
});
reload().then(route).catch(error => {
  main.innerHTML = '<p class="empty">' + escape(error.message) + '</p>';
});

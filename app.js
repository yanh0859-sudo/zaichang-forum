import { createClient } from '@supabase/supabase-js';

const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const nickname = (account) => `匿名同事 ${account.id.slice(0, 6)}`;
const feed = $('#feed');
const authDialog = $('#authDialog');
const cards = new Map();
const commentLoads = new Map();
let user = null;
let posts = [];
let channel = 'all';
let loaded = false;
let loadFailed = false;
let loadSequence = 0;
let realtimeStatus = 'CONNECTING';
let refreshTimer;
let db = null;

function notify(message) {
  $('#toast').textContent = message;
  $('#toast').classList.add('show');
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => $('#toast').classList.remove('show'), 5000);
}

function errorMessage(error) {
  const message = error?.message || String(error);
  if (message.includes('Invalid login credentials')) return '邮箱或密码不正确，请重试。';
  if (message.includes('Email not confirmed')) return '请先点击邮箱里的注册确认链接，再登录。';
  if (message.includes('User already registered')) return '这个邮箱已注册，请直接登录。';
  if (message.includes('rate limit')) return '操作过于频繁，请稍后重试。';
  if (error?.code === '23505') return '你已经举报过这条帖子。';
  if (message.includes('Failed to fetch') || message.includes('NetworkError')) return '网络连接失败，请稍后重试。';
  if (error?.code === '42501') return '没有操作权限，请重新登录后再试。';
  return message;
}

try {
  const url = import.meta.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = import.meta.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (url && key) db = createClient(url, key);
} catch {
  // A malformed public configuration should render an explanation, not a blank page.
}

function updateConnection() {
  const unavailable = !db;
  const offline = !navigator.onLine;
  const connected = realtimeStatus === 'SUBSCRIBED';
  $('#liveIndicator').textContent = unavailable ? '服务待配置' : offline ? '网络已断开' : connected ? '实时已连接' : '实时未连接';
  $('#liveIndicator').classList.toggle('is-connected', !unavailable && !offline && connected);
  $('#connectionStatus').textContent = unavailable ? '网站服务尚未配置，请稍后再访问。'
    : offline ? '网络已断开，输入内容会保留在当前页面。'
      : loadFailed ? '内容刷新失败，请重试。'
        : !loaded ? '正在加载内容…'
          : connected ? '内容实时更新' : '实时连接尚未恢复，可手动刷新内容。';
  $('#profileButton').disabled = unavailable;
  $('#refreshReal').disabled = unavailable;
  $('#composerForm button[type="submit"]').disabled = unavailable || offline || $('#composerForm').dataset.sending === 'true';
}

function updateAccount() {
  $('#identityName').textContent = user ? nickname(user) : '未登录';
  $('#identityHint').textContent = user ? '以这个匿名身份参与讨论' : '可以浏览，登录后匿名发言';
  $('#profileButton').textContent = user ? '退出登录' : '登录 / 注册';
  for (const card of cards.values()) updateActions(card, { user_id: card.dataset.owner });
}

function showAuth() {
  if (!db) return notify('网站服务尚未配置，请稍后再访问。');
  $('#authMessage').textContent = '';
  if (!authDialog.open) authDialog.showModal();
}

function updateActions(card, post) {
  if (!card) return;
  card.querySelector('[data-action="delete"]').hidden = user?.id !== post.user_id;
}

function makeCard(post) {
  const card = document.createElement('article');
  card.className = 'post-card';
  card.dataset.id = post.id;
  card.dataset.channel = post.channel;
  card.dataset.owner = post.user_id;
  card.innerHTML = `<div class="post-meta"><div class="avatar avatar-mint" aria-hidden="true">匿</div><div class="post-author"><strong>${esc(post.nickname)}</strong><span>${esc(post.channel)}</span></div><time class="post-time" datetime="${esc(post.created_at)}">${esc(new Date(post.created_at).toLocaleString('zh-CN'))}</time></div><div class="post-body">${esc(post.body)}</div><div class="post-actions"><button type="button" data-action="comments" class="action-button" aria-expanded="false" aria-controls="comments-${esc(post.id)}">查看 / 回复</button><button type="button" data-action="report" class="action-button">举报</button><button type="button" data-action="delete" class="action-button" hidden>删除我的帖子</button></div><section class="comments" id="comments-${esc(post.id)}" aria-label="评论" hidden><div class="comment-list"></div><p class="comment-status" role="status"></p><button class="action-button" type="button" data-action="refresh-comments">刷新评论</button><form class="reply-form"><label class="sr-only" for="reply-${esc(post.id)}">匿名回复，最多 1000 字</label><textarea id="reply-${esc(post.id)}" name="body" placeholder="匿名回应…" rows="2" required maxlength="1000"></textarea><button type="submit">回复</button></form></section>`;
  updateActions(card, post);
  return card;
}

function showFeedMessage(title, description) {
  let message = $('#feedMessage');
  if (!message) {
    message = document.createElement('div');
    message.id = 'feedMessage';
    message.className = 'empty-state';
    feed.append(message);
  }
  message.innerHTML = `<h2>${esc(title)}</h2><p>${esc(description)}</p>`;
}

function renderPosts() {
  $('#feedMessage')?.remove();
  const currentIds = new Set(posts.map((post) => post.id));
  for (const [id, card] of cards) {
    if (!currentIds.has(id)) {
      // Preserve replies to older posts that leave the 100-post window.
      if (card.querySelector('.reply-form textarea').value.trim() && posts.length === 100) continue;
      card.remove();
      cards.delete(id);
    }
  }
  let previous = null;
  for (const post of posts) {
    let card = cards.get(post.id);
    if (!card) {
      card = makeCard(post);
      cards.set(post.id, card);
      if (previous) previous.after(card);
      else feed.prepend(card);
    } else {
      card.querySelector('.post-body').textContent = post.body;
      card.querySelector('.post-author strong').textContent = post.nickname;
      card.querySelector('.post-author span').textContent = post.channel;
      card.dataset.channel = post.channel;
      card.dataset.owner = post.user_id;
    }
    card.hidden = channel !== 'all' && post.channel !== channel;
    updateActions(card, post);
    previous = card;
  }
  for (const card of cards.values()) card.hidden = channel !== 'all' && card.dataset.channel !== channel;
  if (![...cards.values()].some((card) => !card.hidden)) {
    showFeedMessage('这里还没有发言', '分享一段真实经历，开启这个频道的讨论。');
  }
  $('#feedNote').textContent = posts.length === 100 ? '当前展示全站最新 100 条帖子。' : '';
}

async function loadPosts() {
  if (!db) {
    feed.setAttribute('aria-busy', 'false');
    showFeedMessage('论坛暂时无法连接', '网站管理员需要完成服务配置后才能使用。');
    updateConnection();
    return;
  }
  const sequence = ++loadSequence;
  feed.setAttribute('aria-busy', 'true');
  try {
    const { data, error } = await db.from('posts').select('id,user_id,nickname,channel,body,created_at').order('created_at', { ascending: false }).limit(100);
    if (sequence !== loadSequence) return;
    if (error) throw error;
    posts = data;
    loaded = true;
    loadFailed = false;
    renderPosts();
  } catch (error) {
    if (sequence !== loadSequence) return;
    loadFailed = true;
    if (!loaded) showFeedMessage('暂时无法加载内容', '请检查网络后点击上方“刷新”。');
    notify(errorMessage(error));
  } finally {
    if (sequence === loadSequence) {
      feed.setAttribute('aria-busy', 'false');
      updateConnection();
    }
  }
}

async function loadComments(card) {
  if (!db || !card.isConnected) return;
  const postId = card.dataset.id;
  const sequence = (commentLoads.get(postId) || 0) + 1;
  commentLoads.set(postId, sequence);
  const status = card.querySelector('.comment-status');
  status.textContent = '正在加载评论…';
  try {
    const { data, error } = await db.from('comments').select('id,nickname,body,created_at').eq('post_id', postId).order('created_at', { ascending: false }).limit(200);
    if (commentLoads.get(postId) !== sequence || !card.isConnected) return;
    if (error) throw error;
    card.querySelector('.comment-list').innerHTML = data.reverse().map((comment) => `<div class="comment"><strong>${esc(comment.nickname)}</strong><p>${esc(comment.body)}</p></div>`).join('');
    status.textContent = data.length === 200 ? '当前展示最新 200 条评论。' : data.length ? '' : '还没有评论，来说说你的看法。';
  } catch (error) {
    if (commentLoads.get(postId) !== sequence || !card.isConnected) return;
    status.textContent = `评论加载失败：${errorMessage(error)}`;
  }
}

$('#closeAuth').addEventListener('click', () => authDialog.close());
$('#authForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!db || event.currentTarget.dataset.sending === 'true') return;
  const form = event.currentTarget;
  const signingUp = event.submitter?.value === 'signup';
  const credentials = { email: $('#authEmail').value.trim(), password: $('#authPassword').value };
  form.dataset.sending = 'true';
  form.querySelectorAll('[type="submit"]').forEach((button) => { button.disabled = true; });
  $('#authMessage').textContent = signingUp ? '正在注册…' : '正在登录…';
  try {
    const { data, error } = signingUp ? await db.auth.signUp({ ...credentials, options: { emailRedirectTo: window.location.origin } }) : await db.auth.signInWithPassword(credentials);
    if (error) throw error;
    $('#authPassword').value = '';
    if (data.session) {
      authDialog.close();
      notify(signingUp ? '注册成功，已登录。' : '登录成功。');
    } else {
      $('#authMessage').textContent = '请查看邮箱中的确认邮件，点击链接后回来登录。若已有账号，请直接登录。';
    }
  } catch (error) {
    $('#authMessage').textContent = errorMessage(error);
  } finally {
    delete form.dataset.sending;
    form.querySelectorAll('[type="submit"]').forEach((button) => { button.disabled = false; });
  }
});

$('#profileButton').addEventListener('click', async () => {
  if (!user) return showAuth();
  const button = $('#profileButton');
  button.disabled = true;
  try {
    const { error } = await db.auth.signOut();
    if (error) throw error;
    notify('已退出登录。');
  } catch (error) {
    notify(errorMessage(error));
  } finally {
    updateConnection();
  }
});

$('#postInput').addEventListener('input', () => { $('#postCount').textContent = `${$('#postInput').value.length}/180`; });
$('#composerForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!user) return showAuth();
  const form = event.currentTarget;
  if (form.dataset.sending === 'true') return;
  const input = $('#postInput');
  const original = input.value;
  const body = original.trim();
  if (!body) return notify('请填写内容。');
  const destination = $('#postChannel').value;
  form.dataset.sending = 'true';
  updateConnection();
  try {
    const { error } = await db.from('posts').insert({ body, user_id: user.id, channel: destination, nickname: nickname(user) });
    if (error) throw error;
    if (input.value === original) {
      input.value = '';
      $('#postCount').textContent = '0/180';
    }
    if (channel !== 'all' && channel !== destination) selectChannel(destination);
    await loadPosts();
    notify('已发布。');
  } catch (error) {
    notify(errorMessage(error));
  } finally {
    delete form.dataset.sending;
    updateConnection();
  }
});

function selectChannel(value) {
  channel = value;
  document.querySelectorAll('[data-channel]').forEach((button) => {
    button.classList.toggle('active', button.dataset.channel === channel);
    button.setAttribute('aria-pressed', String(button.dataset.channel === channel));
  });
  if (channel !== 'all' && !$('#postInput').value) $('#postChannel').value = channel;
  if (loaded) renderPosts();
}
$('#channelNav').addEventListener('click', (event) => {
  const button = event.target.closest('[data-channel]');
  if (button) selectChannel(button.dataset.channel);
});

feed.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action]');
  const card = event.target.closest('[data-id]');
  if (!button || !card || !db) return;
  const action = button.dataset.action;
  if (action === 'comments') {
    const section = card.querySelector('.comments');
    section.hidden = !section.hidden;
    button.setAttribute('aria-expanded', String(!section.hidden));
    if (!section.hidden) await loadComments(card);
    return;
  }
  if (action === 'refresh-comments') return loadComments(card);
  if (!user) return showAuth();
  if (action === 'report') {
    const reason = window.prompt('请说明举报原因（最多 1000 字）');
    if (!reason?.trim()) return;
    if (reason.trim().length > 1000) return notify('举报原因请控制在 1000 字以内。');
    button.disabled = true;
    try {
      const { error } = await db.from('reports').insert({ post_id: card.dataset.id, user_id: user.id, reason: reason.trim() });
      if (error) throw error;
      notify('举报已记录，等待审核。');
    } catch (error) { notify(errorMessage(error)); }
    finally { button.disabled = false; }
  }
  if (action === 'delete' && window.confirm('删除这条帖子及其全部评论？删除后无法恢复。')) {
    button.disabled = true;
    try {
      const { error } = await db.from('posts').delete().eq('id', card.dataset.id).eq('user_id', user.id);
      if (error) throw error;
      card.remove();
      cards.delete(card.dataset.id);
      await loadPosts();
      notify('帖子已删除。');
    } catch (error) { notify(errorMessage(error)); }
    finally { button.disabled = false; }
  }
});

feed.addEventListener('submit', async (event) => {
  if (!event.target.matches('.reply-form')) return;
  event.preventDefault();
  if (!user) return showAuth();
  const form = event.target;
  const input = form.querySelector('textarea');
  const original = input.value;
  const body = original.trim();
  if (!body || form.dataset.sending === 'true') return;
  const card = form.closest('[data-id]');
  const button = form.querySelector('button');
  form.dataset.sending = 'true';
  button.disabled = true;
  try {
    const { error } = await db.from('comments').insert({ post_id: card.dataset.id, user_id: user.id, nickname: nickname(user), body });
    if (error) throw error;
    if (input.value === original) input.value = '';
    await loadComments(card);
    notify('已回复。');
  } catch (error) { notify(errorMessage(error)); }
  finally { delete form.dataset.sending; button.disabled = false; }
});

async function refreshAll() {
  await loadPosts();
  await Promise.allSettled([...cards.values()].filter((card) => !card.querySelector('.comments').hidden).map(loadComments));
}
$('#refreshReal').addEventListener('click', refreshAll);
window.addEventListener('offline', updateConnection);
window.addEventListener('online', () => { updateConnection(); refreshAll(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && loaded) refreshAll(); });

if (db) {
  db.auth.onAuthStateChange((_event, session) => {
    user = session?.user || null;
    updateAccount();
  });
  db.channel('forum')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'posts' }, (payload) => {
      if (payload.eventType === 'DELETE' && payload.old?.id) {
        cards.get(payload.old.id)?.remove();
        cards.delete(payload.old.id);
      }
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(loadPosts, 150);
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'comments' }, (payload) => {
      const postId = payload.new?.post_id || payload.old?.post_id;
      for (const card of cards.values()) {
        if ((!postId || card.dataset.id === postId) && !card.querySelector('.comments').hidden) loadComments(card);
      }
    })
    .subscribe((status) => {
      realtimeStatus = status;
      updateConnection();
      if (status === 'SUBSCRIBED') refreshAll();
    });
}
updateConnection();
loadPosts();

import {defineConfig, loadEnv} from 'vite';

export default defineConfig(({command, mode}) => {
  const env = {...loadEnv(mode, process.cwd(), 'NEXT_PUBLIC_'), ...process.env};
  if (command === 'build') {
    const url = env.NEXT_PUBLIC_SUPABASE_URL;
    const key = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    if (!url || !key) throw new Error('请在 Vercel 添加 NEXT_PUBLIC_SUPABASE_URL 和 NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY 后重新部署。');
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(url)) throw new Error('Supabase URL 必须是项目的 https://…supabase.co 地址。');
    if (key.startsWith('sb_secret_')) throw new Error('前端只能使用 Supabase Publishable key，不能使用 Secret key。');
    if (key.startsWith('eyJ')) {
      let claims;
      try { claims = JSON.parse(Buffer.from(key.split('.')[1], 'base64url')); } catch { throw new Error('Supabase 密钥格式不正确。'); }
      if (claims.role !== 'anon') throw new Error('请使用 anon 或 Publishable key，不能使用 service_role。');
    } else if (!key.startsWith('sb_publishable_')) throw new Error('请使用 sb_publishable_ 开头的公开密钥。');
  }
  return {envPrefix: ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY']};
});

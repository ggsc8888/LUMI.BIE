import { settings } from './env.js';
import { handler, query, redirect } from './http.js';
import { finishConnect } from './oauth.js';

// The platform sends the browser back here after the person clicks "Allow".
export const callback = platform => handler(async (request, response) => {
  const { location, setCookie } = await finishConnect({ request, params: query(request), config: settings(), platform, env: process.env });
  redirect(response, location, { 'Set-Cookie': setCookie });
});

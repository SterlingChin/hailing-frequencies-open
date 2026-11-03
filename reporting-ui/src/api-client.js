/** Retry only requests the server rejected before processing due to lost
 * browser-session state. Never retry a provider failure or an accepted action. */
export function createApiClient({ fetchImpl = fetch, getCsrf, setCsrf, onRecovered = () => {} }) {
  let recovering;
  async function send(path, body) {
    const response = await fetchImpl(path, {
      method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrf() },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { response, data: await response.json() };
  }
  return async function request(path, body) {
    const attemptedCsrf = getCsrf();
    let result = await send(path, body);
    if (result.response.status === 401 && result.data.code === 'browser_session_reset' && path !== '/api/session') {
      if (getCsrf() === attemptedCsrf) {
        recovering ??= (async () => {
          const fresh = await send('/api/session');
          if (!fresh.response.ok) throw new Error('Could not reconnect to the app. Try Engage again.');
          setCsrf(fresh.data.csrf); onRecovered(fresh.data);
        })().finally(() => { recovering = null; });
        await recovering;
      }
      result = await send(path, body);
    }
    if (!result.response.ok) throw new Error(result.data.error || 'This action could not finish. Try again.');
    return result.data;
  };
}

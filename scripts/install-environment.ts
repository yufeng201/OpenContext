/** Network configuration is needed only while fetching locked dependencies. */
export function installationEnvironment(
  isolated: NodeJS.ProcessEnv,
  inherited: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const result = { ...isolated };
  for (const key of [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
    'NODE_EXTRA_CA_CERTS',
  ]) {
    if (inherited[key] !== undefined) result[key] = inherited[key];
  }
  return result;
}

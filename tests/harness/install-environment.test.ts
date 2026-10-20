import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installationEnvironment } from '../../scripts/install-environment.ts';

test('frozen installation preserves explicit proxy and CA configuration without mutating runtime environment', () => {
  const isolated = {
    PATH: '/synthetic/bin',
    NPM_CONFIG_USERCONFIG: '/synthetic/empty-npmrc',
    NPM_CONFIG_GLOBALCONFIG: '/synthetic/empty-npmrc',
  };
  const network = {
    HTTP_PROXY: 'http://proxy.example.invalid:8080',
    HTTPS_PROXY: 'http://proxy.example.invalid:8080',
    http_proxy: 'http://proxy.example.invalid:8080',
    https_proxy: 'http://proxy.example.invalid:8080',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
    NODE_EXTRA_CA_CERTS: '/synthetic/platform-ca.pem',
  };
  assert.deepEqual(installationEnvironment(isolated, network), {
    ...isolated,
    ...network,
  });
  assert.deepEqual(isolated, {
    PATH: '/synthetic/bin',
    NPM_CONFIG_USERCONFIG: '/synthetic/empty-npmrc',
    NPM_CONFIG_GLOBALCONFIG: '/synthetic/empty-npmrc',
  });
  assert.deepEqual(installationEnvironment(isolated, {}), isolated);
});

test('installation does not inherit application credentials, npm auth configuration or execution overrides', () => {
  const isolated = {
    PATH: '/synthetic/bin',
    NPM_CONFIG_USERCONFIG: '/synthetic/empty-npmrc',
    NPM_CONFIG_GLOBALCONFIG: '/synthetic/empty-npmrc',
  };
  const rejected = {
    PATH: '/untrusted/bin',
    OPENCONTEXT_OWNER_TOKEN: 'synthetic-owner',
    OPENCONTEXT_QUERY_TOKEN: 'synthetic-reader',
    OPENCONTEXT_FEISHU_TOKEN: 'synthetic-feishu',
    NPM_TOKEN: 'synthetic-registry-token',
    NODE_AUTH_TOKEN: 'synthetic-node-auth-token',
    NPM_CONFIG_USERCONFIG: '/synthetic/private-npmrc',
    NPM_CONFIG_GLOBALCONFIG: '/synthetic/private-global-npmrc',
    NPM_CONFIG_REGISTRY: 'https://registry.example.invalid',
    npm_config_registry: 'https://registry.example.invalid',
    npm_config_userconfig: '/synthetic/private-lowercase-npmrc',
    npm_config_globalconfig: '/synthetic/private-global-lowercase-npmrc',
    npm_config__auth: 'synthetic-auth',
    'npm_config_//registry.npmjs.org/:_authToken': 'synthetic-auth-token',
    npm_config_strict_ssl: 'false',
    NPM_CONFIG_CAFILE: '/synthetic/unreviewed-ca.pem',
    ALL_PROXY: 'socks5://proxy.example.invalid:1080',
    all_proxy: 'socks5://proxy.example.invalid:1080',
    SSL_CERT_FILE: '/synthetic/unreviewed-ca.pem',
    SSL_CERT_DIR: '/synthetic/unreviewed-certs',
    CURL_CA_BUNDLE: '/synthetic/unreviewed-ca.pem',
    NODE_OPTIONS: '--require=/synthetic/unwanted.js',
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
    GIT_CONFIG_GLOBAL: '/synthetic/private-gitconfig',
  };
  assert.deepEqual(installationEnvironment(isolated, rejected), isolated);
});

/* eslint-disable */
/* hand-maintained napi loader */

const { existsSync } = require('fs');
const { join } = require('path');

const { platform, arch } = process;

let nativeBinding = null;
let loadError = null;

const triples = {
  'darwin-x64': 'predict.darwin-x64.node',
  'darwin-arm64': 'predict.darwin-arm64.node',
  'linux-x64': 'predict.linux-x64-gnu.node',
  'linux-arm64': 'predict.linux-arm64-gnu.node',
  'win32-x64': 'predict.win32-x64-msvc.node',
};

const triple = `${platform}-${arch}`;
const localFile = triples[triple];

if (!localFile) {
  throw new Error(`Unsupported platform: ${platform}-${arch}`);
}

const localPath = join(__dirname, 'native', localFile);

if (existsSync(localPath)) {
  try {
    nativeBinding = require(localPath);
  } catch (e) {
    loadError = e;
  }
} else {
  // Try the npm optional-dependency package
  const pkgName = `@zaraa/predict-${triple}`;
  try {
    nativeBinding = require(pkgName);
  } catch (e) {
    loadError = e;
  }
}

if (!nativeBinding) {
  if (loadError) {
    throw loadError;
  }
  throw new Error(`Failed to load native binding for ${triple}`);
}

const { ping, ZaraaPredict } = nativeBinding;

module.exports.ping = ping;
module.exports.ZaraaPredict = ZaraaPredict;

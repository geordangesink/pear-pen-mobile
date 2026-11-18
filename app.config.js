const { version } = require('./package.json')
const { expo } = require('./app.json')
const build = Number(process.env.BUILD_NUMBER || 1)
if (!Number.isSafeInteger(build) || build < 1 || build > 2100000000) {
  throw new Error('BUILD_NUMBER must be a positive integer no greater than 2100000000')
}
module.exports = {
  ...expo,
  version,
  ios: { ...expo.ios, buildNumber: String(build) },
  android: { ...expo.android, versionCode: build }
}

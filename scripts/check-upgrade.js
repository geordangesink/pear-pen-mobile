const fs = require('fs')
const path = require('path')
const link = require('pear-link')
const filename = path.join(__dirname, '..', 'package.json')
const pkg = JSON.parse(fs.readFileSync(filename, 'utf8'))
const upgrade = process.env.UPGRADE_KEY || pkg.upgrade
try {
  if (typeof upgrade !== 'string' || !/^pear:\/\/[a-z\d]{52}$/.test(upgrade)) {
    throw new Error('Use a canonical Pear link')
  }
  link.parse(upgrade)
} catch {
  throw new Error(
    'Set UPGRADE_KEY or package.json upgrade to your Pear deployment link before building a release.'
  )
}
if (pkg.upgrade !== upgrade)
  fs.writeFileSync(filename, JSON.stringify({ ...pkg, upgrade }, null, 2) + '\n')

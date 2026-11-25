const { withInfoPlist } = require('expo/config-plugins')

module.exports = (config) =>
  withInfoPlist(config, (config) => {
    const code = process.env.IOS_EXPORT_COMPLIANCE_CODE?.trim()
    const plist = config.modResults
    if (code) {
      plist.ITSAppUsesNonExemptEncryption = true
      plist.ITSEncryptionExportComplianceCode = code
    } else {
      delete plist.ITSAppUsesNonExemptEncryption
      delete plist.ITSEncryptionExportComplianceCode
    }
    return config
  })

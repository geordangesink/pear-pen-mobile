const { withInfoPlist } = require('expo/config-plugins')

module.exports = (config) =>
  withInfoPlist(config, (config) => {
    const code = process.env.IOS_EXPORT_COMPLIANCE_CODE?.trim()
    if (code) config.modResults.ITSEncryptionExportComplianceCode = code
    else delete config.modResults.ITSEncryptionExportComplianceCode
    return config
  })

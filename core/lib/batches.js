// Adapted from Holepunch's multisig-tools 5.1.2 with failed-batch cleanup; see ../NOTICE.
const { assemble, partialSignature } = require('hypercore/lib/multisig')

async function createUpdateBatch(core, source, { start, end } = {}) {
  start = start ?? core.length
  end = end ?? source.length
  await source.download({ start, end }).done()
  const batch = core.session({ name: 'batch', overwrite: true })
  try {
    for (let index = start; index < end; index++) {
      await batch.append(await source.get(index))
    }
    return batch
  } catch (error) {
    await batch.close()
    throw error
  }
}

async function commitUpdateBatch(core, batch, signatures, { length } = {}) {
  length = length || batch.length
  const proofs = await Promise.all(
    signatures.map((signature, index) =>
      signature
        ? partialSignature(batch, index, length, length, signature)
        : null
    )
  )
  const signature = assemble(proofs.filter(Boolean))
  await core.commit(batch, { signature, length })
  return signature
}

module.exports = { createUpdateBatch, commitUpdateBatch }

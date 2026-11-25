const b4a = require('b4a')
const Hypercore = require('hypercore')
const { assemble } = require('hypercore/lib/multisig')
const { createUpdateBatch } = require('hyper-multisig/lib/sign')

module.exports = async function commitDrive(room, source, request, signatures) {
  const staging = room.target.corestore.session()
  const commits = []
  try {
    for (const [target, from, signed, index] of [
      [room.contentCore, source.blobs.core, request.content, 1],
      [room.target.core, source.core, request, 0]
    ]) {
      const base = staging.get(target.key)
      await base.ready()
      const start = base.length
      const batch =
        start < signed.length
          ? await createUpdateBatch(base, from, {
              start,
              length: signed.length
            })
          : base
      if (
        batch.fork !== request.fork ||
        batch.length !== signed.length ||
        !b4a.equals(await Hypercore.treeHashFromStorage(batch), signed.treeHash)
      )
        throw new Error('The source data does not match the signed request')
      if (batch === base) continue
      const proofs = signatures.flatMap((pair, signer) =>
        pair ? [{ signer, signature: pair[index], patch: 0 }] : []
      )
      commits.push({ target, batch, signature: assemble(proofs) })
    }
    if (
      source.core.fork !== request.fork ||
      source.blobs.core.fork !== request.fork
    )
      throw new Error('The source drive changed forks after this request')
    for (const { target, batch, signature } of commits) {
      if (
        target.fork !== request.fork ||
        !(await target.commit(batch, { signature }))
      )
        throw new Error(
          'The multisig drive changed while committing the request'
        )
    }
  } finally {
    await staging.close()
  }
}

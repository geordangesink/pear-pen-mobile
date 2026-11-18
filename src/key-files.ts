import { Directory, File, Paths } from 'expo-file-system'
import { isAvailableAsync, shareAsync } from 'expo-sharing'

const exportsDirectory = () => new Directory(Paths.cache, 'pear-pen-key-exports')

export function clearKeyExports() {
  const directory = exportsDirectory()
  if (directory.exists) directory.delete()
}

export async function shareKey(name: string, key: string) {
  if (!(await isAvailableAsync())) throw new Error('Sharing is unavailable. Copy the key instead.')
  const directory = new Directory(exportsDirectory(), String(Date.now()))
  try {
    directory.create({ intermediates: true })
    const file = new File(directory, name)
    file.create()
    file.write(key + '\n')
    await shareAsync(file.uri, { mimeType: 'application/octet-stream', dialogTitle: 'Export key' })
  } finally {
    if (directory.exists) directory.delete()
  }
}

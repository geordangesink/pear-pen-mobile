import * as DocumentPicker from 'expo-document-picker'
import { File } from 'expo-file-system'
import { requireOptionalNativeModule } from 'expo-modules-core'

export async function choosePenImage(): Promise<string | null> {
  if (!requireOptionalNativeModule('ExpoImageManipulator')) {
    throw new Error('Update Pear Pen from your app store to change pen images.')
  }
  const { ImageManipulator, SaveFormat } = await import('expo-image-manipulator')
  const result = await DocumentPicker.getDocumentAsync({
    type: ['image/jpeg', 'image/png', 'image/webp'],
    copyToCacheDirectory: true,
    multiple: false
  })
  if (result.canceled) return null
  const asset = result.assets[0]
  const bytes = asset.size ?? new File(asset.uri).size
  if (!Number.isFinite(bytes) || bytes <= 0) {
    throw new Error('Could not read this image. Try another file.')
  }
  if (bytes > 20 * 1024 * 1024) throw new Error('Choose an image smaller than 20 MB.')
  const context = ImageManipulator.manipulate(asset.uri)
  try {
    const original = await context.renderAsync()
    const side = Math.min(original.width, original.height)
    const crop = {
      originX: Math.floor((original.width - side) / 2),
      originY: Math.floor((original.height - side) / 2),
      width: side,
      height: side
    }
    original.release()
    const image = await context.crop(crop).resize({ width: 192, height: 192 }).renderAsync()
    try {
      const result = await image.saveAsync({
        format: SaveFormat.JPEG,
        compress: 0.85,
        base64: true
      })
      if (!result.base64) throw new Error('Could not read the image. Try another file.')
      const data = `data:image/jpeg;base64,${result.base64}`
      if (data.length > 128 * 1024) throw new Error('The image is too large. Try another file.')
      return data
    } finally {
      image.release()
    }
  } finally {
    context.release()
  }
}

import { Image, View } from 'react-native'
import { Icon, type Palette } from './ui'
import { styles } from './styles'

export default function PenAvatar({
  image,
  colors,
  size = 52
}: {
  image?: string | null
  colors: Palette
  size?: number
}) {
  return (
    <View
      style={[
        styles.penAvatar,
        {
          width: size,
          height: size,
          borderRadius: Math.round(size * 0.35),
          backgroundColor: colors.soft,
          overflow: 'hidden'
        }
      ]}
    >
      {image ? (
        <Image
          source={{ uri: image }}
          style={{ width: '100%', height: '100%' }}
          accessibilityIgnoresInvertColors
        />
      ) : (
        <Icon name='pencil-outline' color={colors.success} size={Math.round(size * 0.48)} />
      )}
    </View>
  )
}

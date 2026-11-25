import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState, type TextInput } from 'react-native'

export function usePassword() {
  const input = useRef<TextInput>(null)
  const value = useRef('')
  const [filled, setFilled] = useState(false)

  const clear = useCallback(() => {
    value.current = ''
    input.current?.clear()
    setFilled(false)
  }, [])

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'background') clear()
    })
    return () => {
      value.current = ''
      subscription.remove()
    }
  }, [clear])

  function onChange(text: string) {
    value.current = text
    setFilled(!!text)
  }

  function take(keepForAutofill = false) {
    const password = value.current
    value.current = ''
    setFilled(false)
    if (!keepForAutofill) input.current?.clear()
    return password
  }

  return { input, filled, onChange, clear, take }
}

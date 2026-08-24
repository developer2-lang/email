import { useEffect, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'

/**
 * useState that transparently persists to/from localStorage under `key`.
 * Falls back to the provided initial value when storage is unavailable or empty.
 */
export function useLocalStorage<T>(
  key: string,
  initialValue: T,
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = window.localStorage.getItem(key)
      return raw !== null ? (JSON.parse(raw) as T) : initialValue
    } catch {
      return initialValue
    }
  })

  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(value))
    } catch {
      // Storage unavailable (private mode, quota, etc.) — persist silently.
    }
  }, [key, value])

  return [value, setValue]
}

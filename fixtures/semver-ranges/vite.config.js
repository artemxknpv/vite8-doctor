import wideLt from 'vite-plugin-wide-lt'
import hyphen from 'vite-plugin-hyphen-range'
import v7Only from 'vite-plugin-v7-only'

export default {
  plugins: [wideLt(), hyphen(), v7Only()]
}

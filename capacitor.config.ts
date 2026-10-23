import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.aurora.music',
  appName: 'Aurora Music',
  webDir: 'dist-mobile',
  backgroundColor: '#101015',
  android: { backgroundColor: '#101015' },
  server: { androidScheme: 'https' },
}
export default config

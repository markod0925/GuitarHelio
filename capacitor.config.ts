import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.guitarhelio.app',
  appName: 'GuitarHelio',
  webDir: 'dist',
  server: {
    androidScheme: 'https'
  }
};

export default config;

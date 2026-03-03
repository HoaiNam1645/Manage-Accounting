const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');

module.exports = {
  packagerConfig: {
    asar: true,
    // App icon (optional - add icon files later if needed)
    // icon: './assets/icon', // no extension needed, Forge adds .icns/.ico
  },
  rebuildConfig: {
    onlyModules: ['robotjs'], // Đảm bảo rebuild native modules
  },
  makers: [
    {
      // Windows installer (Squirrel) - required for auto-update on Windows
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'HidemyaccRunner',
        // setupIcon: './assets/icon.ico', // optional
      },
    },
    {
      // ZIP for macOS - required for auto-update on macOS
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
    },
    {
      name: '@electron-forge/maker-deb',
      config: {},
    },
    {
      name: '@electron-forge/maker-rpm',
      config: {},
    },
  ],
  publishers: [
    {
      name: '@electron-forge/publisher-github',
      config: {
        repository: {
          owner: 'HoaiNam1645',
          name: 'Manage-Accounting',
        },
        prerelease: false,
        draft: false, // Draft mode: bạn review trước khi publish chính thức
      },
    },
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-auto-unpack-natives',
      config: {},
    },
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

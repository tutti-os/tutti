export const generatedDefaults = {
  state: {
    productionDirName: ".tutti",
    developmentDirName: ".tutti-dev",
    runDirName: "run",
    logsDirName: "logs",
    dbFileName: "tuttid.db",
    daemonLogFileName: "tuttid.log",
    desktopLogFileName: "tutti-desktop.log",
    listenerInfoFileName: "tuttid.listener.json",
    pidFileName: "tuttid.pid"
  },
  transport: {
    defaultTCPAddr: "127.0.0.1:4545"
  },
  logging: {
    defaultLevel: "info",
    defaultOutput: "file",
    maxSizeMB: 50,
    maxBackups: 10,
    maxAgeDays: 14,
    maxTotalMB: 300
  },
  analytics: {
    appId: 20004134,
    appName: "tutti",
    subjectId: 121,
    subjectName: "主体1",
    appKey: "984646081c1dc9dbe502e9c5e17711fbf9d9fdb85047eb7808db4776c34c0af0",
    appUrl: "rangers://532d862c96b91d551414e6b5319578dd/MjAwMDQxMzQ=",
    urlScheme: "rangersapplog.616f8d4eba9201bc",
    channel: "sg",
    channelDomain: "https://gator.uba.ap-southeast-1.volces.com",
    appVersion: "0.0.0"
  },
  agentExtensions: {
    sources: [
      {
        key: "gemini",
        releaseIndexUrl:
          "https://d1x7gb6wqsqmnm.cloudfront.net/tutti-agent-releases/agents/gemini/versions.json",
        signingKeyId: "tutti-gemini-release-v1",
        signingPublicKey:
          "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAXKvHPk/lWXqeK3Q1cg6vaOFfhqmXm3jcNgECsZ9XT/g=\n-----END PUBLIC KEY-----\n",
        enabled: false
      },
      {
        key: "codebuddy",
        releaseIndexUrl:
          "https://d1x7gb6wqsqmnm.cloudfront.net/tutti-agent-releases/agents/codebuddy/versions.json",
        signingKeyId: "tutti-codebuddy-release-v1",
        signingPublicKey:
          "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAfzdtf41+SN0hrZqK0JX2pdDluCwpUbn1HPDoz4D7OxA=\n-----END PUBLIC KEY-----\n",
        enabled: false
      }
    ]
  }
} as const;

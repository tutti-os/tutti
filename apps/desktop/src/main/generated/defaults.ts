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
      },
      {
        key: "copilot",
        releaseIndexUrl:
          "https://d1x7gb6wqsqmnm.cloudfront.net/tutti-agent-releases/agents/copilot/versions.json",
        signingKeyId: "tutti-copilot-release-v1",
        signingPublicKey:
          "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA1U8JW/V2ZwXbflqpktbpC68cuI3xq0OU2yV4H5vsz+c=\n-----END PUBLIC KEY-----\n",
        enabled: false
      },
      {
        key: "kilo",
        releaseIndexUrl:
          "https://d1x7gb6wqsqmnm.cloudfront.net/tutti-agent-releases/agents/kilo/versions.json",
        signingKeyId: "tutti-kilo-release-v1",
        signingPublicKey:
          "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAc0h7Dl9Vw1FnNGBm612Pj/yVsQW+UKXfDskBEVHeMGI=\n-----END PUBLIC KEY-----\n",
        enabled: false
      },
      {
        key: "qwen",
        releaseIndexUrl:
          "https://d1x7gb6wqsqmnm.cloudfront.net/tutti-agent-releases/agents/qwen/versions.json",
        signingKeyId: "tutti-qwen-release-v1",
        signingPublicKey:
          "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEANqN38E9u53Ohnyzy8IC9lPXOmOCrZwxTb7Do2hM22t0=\n-----END PUBLIC KEY-----\n",
        enabled: false
      },
      {
        key: "hermes",
        releaseIndexUrl:
          "https://d1x7gb6wqsqmnm.cloudfront.net/tutti-agent-releases/agents/hermes/versions.json",
        signingKeyId: "tutti-hermes-release-v1",
        signingPublicKey:
          "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAIeel8ddNiN3b4qOq0KucF3BRxfi3zourM0BVyGuP8eY=\n-----END PUBLIC KEY-----\n",
        enabled: false
      },
      {
        key: "kimi-code",
        releaseIndexUrl:
          "https://d1x7gb6wqsqmnm.cloudfront.net/tutti-agent-releases/agents/kimi-code/versions.json",
        signingKeyId: "tutti-kimi-code-release-v1",
        signingPublicKey:
          "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAnO+V8MpPIY90uDINyaJjtENg/vPQpURo0AltBZLqvgw=\n-----END PUBLIC KEY-----\n",
        enabled: false
      },
      {
        key: "grok",
        releaseIndexUrl:
          "https://d1x7gb6wqsqmnm.cloudfront.net/tutti-agent-releases/agents/grok/versions.json",
        signingKeyId: "tutti-grok-release-v2",
        signingPublicKey:
          "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAwEnBjsJWjJnmmCCmS2MZTMaNJZSkfVhL7rm3lcsutyA=\n-----END PUBLIC KEY-----\n",
        enabled: false
      }
    ]
  },
  agentRuntimeTools: {
    uv: {
      version: "0.11.31",
      artifacts: [
        {
          platform: "darwin-arm64",
          url: "https://github.com/astral-sh/uv/releases/download/0.11.31/uv-aarch64-apple-darwin.tar.gz",
          sha256:
            "b2b93e82a6786f9c7cb89fd4ca0e859a147b292ae8f6f95784f9742f0efec39e",
          sizeBytes: 22411216,
          archive: "tar.gz",
          archiveExecutable: "uv-aarch64-apple-darwin/uv"
        },
        {
          platform: "darwin-amd64",
          url: "https://github.com/astral-sh/uv/releases/download/0.11.31/uv-x86_64-apple-darwin.tar.gz",
          sha256:
            "33ee6bd62b57fcd77a499deb54e4432dc1e1a2f3d34930ba987ad8b43f9c7bc7",
          sizeBytes: 24112641,
          archive: "tar.gz",
          archiveExecutable: "uv-x86_64-apple-darwin/uv"
        },
        {
          platform: "linux-amd64",
          url: "https://github.com/astral-sh/uv/releases/download/0.11.31/uv-x86_64-unknown-linux-gnu.tar.gz",
          sha256:
            "8cc1cd82d434ec565376f98bd938d4b715b5791a80ff2d3aa78821cf85091b4b",
          sizeBytes: 26181465,
          archive: "tar.gz",
          archiveExecutable: "uv-x86_64-unknown-linux-gnu/uv"
        },
        {
          platform: "linux-arm64",
          url: "https://github.com/astral-sh/uv/releases/download/0.11.31/uv-aarch64-unknown-linux-gnu.tar.gz",
          sha256:
            "d74f23949fd07be4970f293d06ca99d87cd2a78a341c3d7b7fc0df7bc2d8a145",
          sizeBytes: 24478446,
          archive: "tar.gz",
          archiveExecutable: "uv-aarch64-unknown-linux-gnu/uv"
        },
        {
          platform: "windows-amd64",
          url: "https://github.com/astral-sh/uv/releases/download/0.11.31/uv-x86_64-pc-windows-msvc.zip",
          sha256:
            "410c2fd3126ff621c9450a21cfc200002c7540dc48d130069a8f619cdb0a811b",
          sizeBytes: 25653699,
          archive: "zip",
          archiveExecutable: "uv.exe"
        }
      ]
    }
  }
} as const;

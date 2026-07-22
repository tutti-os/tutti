import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { workspaceFilePreviewMaxBytes } from "@tutti-os/workspace-file-preview";
import { desktopErrorCodes } from "../../shared/errors/desktopErrors.ts";
import { createWorkspaceFileHostAccess } from "./workspaceFileHostAccess.ts";

test("workspace file host access resolves workspace file URLs for app browser launch", async () => {
  const workspaceRoot = await createWorkspaceRootWithFile(
    "public/index.html",
    "<html></html>"
  );
  const restoreHome = installHomeDirectory(workspaceRoot);
  try {
    const hostAccess = createWorkspaceFileHostAccess({});

    const fileUrl = await hostAccess.resolveWorkspaceFileFileUrl({
      path: path.join(workspaceRoot, "public/index.html"),
      workspaceID: "workspace-1"
    });

    assert.equal(
      fileUrl,
      pathToFileURL(path.resolve(workspaceRoot, "public/index.html")).href
    );
  } finally {
    restoreHome();
  }
});

test("workspace file host access opens browser-openable files in the default browser", async () => {
  const workspaceRoot = await createWorkspaceRootWithFile(
    "public/index.html",
    "<html></html>"
  );
  const restoreHome = installHomeDirectory(workspaceRoot);
  try {
    const openedInBrowserPaths: string[] = [];
    const hostAccess = createWorkspaceFileHostAccess({
      openFileWithDefaultBrowser: async (targetPath) => {
        openedInBrowserPaths.push(targetPath);
      }
    });
    const targetPath = path.join(workspaceRoot, "public/index.html");

    await hostAccess.openFileInBrowser({
      path: targetPath,
      workspaceID: "workspace-1"
    });

    assert.deepEqual(openedInBrowserPaths, [
      path.resolve(workspaceRoot, "public/index.html")
    ]);
  } finally {
    restoreHome();
  }
});

test("workspace file host access resolves and opens workspace files", async () => {
  const workspaceRoot = await createWorkspaceRootWithFile("src/App.tsx", "app");
  const restoreHome = installHomeDirectory(workspaceRoot);
  try {
    const openedPaths: string[] = [];
    const hostAccess = createWorkspaceFileHostAccess({
      openPath: async (targetPath) => {
        openedPaths.push(targetPath);
        return "";
      }
    });

    await hostAccess.openFile({
      path: path.join(workspaceRoot, "src/App.tsx"),
      workspaceID: "workspace-1"
    });

    assert.deepEqual(openedPaths, [path.resolve(workspaceRoot, "src/App.tsx")]);
  } finally {
    restoreHome();
  }
});

test("workspace file host access resolves external absolute workspace file paths", async () => {
  const homeRoot = await createWorkspaceRootWithFile("home.txt", "home");
  const externalRoot = await createWorkspaceRootWithFile(
    "exports/report.txt",
    "external"
  );
  const targetPath = path.join(externalRoot, "exports/report.txt");
  const restoreHome = installHomeDirectory(homeRoot);
  try {
    const openedPaths: string[] = [];
    let revealedPath = "";
    const hostAccess = createWorkspaceFileHostAccess({
      openPath: async (targetPath) => {
        openedPaths.push(targetPath);
        return "";
      },
      showItemInFolder(targetPath) {
        revealedPath = targetPath;
      }
    });

    await hostAccess.openFile({
      path: targetPath,
      workspaceID: "workspace-1"
    });
    const fileUrl = await hostAccess.resolveWorkspaceFileFileUrl({
      path: targetPath,
      workspaceID: "workspace-1"
    });
    const bytes = await hostAccess.readPreviewFile({
      path: targetPath,
      workspaceID: "workspace-1"
    });
    await hostAccess.revealWorkspaceFile({
      path: targetPath,
      workspaceID: "workspace-1"
    });

    assert.deepEqual(openedPaths, [path.resolve(targetPath)]);
    assert.equal(fileUrl, pathToFileURL(path.resolve(targetPath)).href);
    assert.equal(Buffer.from(bytes).toString("utf8"), "external");
    assert.equal(revealedPath, path.resolve(targetPath));
  } finally {
    restoreHome();
  }
});

test("workspace file host access treats missing default applications as handled", async () => {
  const workspaceRoot = await createWorkspaceRootWithFile(
    "exports/report.tutti-unknown",
    "opaque"
  );
  const restoreHome = installHomeDirectory(workspaceRoot);
  try {
    const hostAccess = createWorkspaceFileHostAccess({
      openPath: async () =>
        [
          "The application cannot be opened for an unexpected reason,",
          "error=Error Domain=NSOSStatusErrorDomain Code=-10814",
          '"kLSApplicationNotFoundErr: no application claims the file"'
        ].join(" ")
    });

    await hostAccess.openFile({
      path: path.join(workspaceRoot, "exports/report.tutti-unknown"),
      workspaceID: "workspace-1"
    });
  } finally {
    restoreHome();
  }
});

test("workspace file host access treats generic openPath failures for existing files as handled", async () => {
  const workspaceRoot = await createWorkspaceRootWithFile(
    "exports/report.tutti-unknown",
    "opaque"
  );
  const restoreHome = installHomeDirectory(workspaceRoot);
  try {
    const hostAccess = createWorkspaceFileHostAccess({
      openPath: async () => "Failed to open path"
    });

    await hostAccess.openFile({
      path: path.join(workspaceRoot, "exports/report.tutti-unknown"),
      workspaceID: "workspace-1"
    });
  } finally {
    restoreHome();
  }
});

test("workspace file host access rejects generic openPath failures for missing files", async () => {
  const workspaceRoot = await createWorkspaceRootWithFile("src/App.tsx", "app");
  const restoreHome = installHomeDirectory(workspaceRoot);
  try {
    const hostAccess = createWorkspaceFileHostAccess({
      openPath: async () => "Failed to open path"
    });

    await assert.rejects(
      () =>
        hostAccess.openFile({
          path: path.join(workspaceRoot, "src/Missing.tsx"),
          workspaceID: "workspace-1"
        }),
      /Failed to open path/
    );
  } finally {
    restoreHome();
  }
});

test("workspace file host access still rejects unexpected open failures", async () => {
  const workspaceRoot = await createWorkspaceRootWithFile("src/App.tsx", "app");
  const restoreHome = installHomeDirectory(workspaceRoot);
  try {
    const hostAccess = createWorkspaceFileHostAccess({
      openPath: async () => "permission denied"
    });

    await assert.rejects(
      () =>
        hostAccess.openFile({
          path: path.join(workspaceRoot, "src/App.tsx"),
          workspaceID: "workspace-1"
        }),
      /permission denied/
    );
  } finally {
    restoreHome();
  }
});

test("workspace file host access resolves terminal links for workspace, relative, and absolute paths", async () => {
  const openedPaths: string[] = [];
  const workspaceRoot = await createWorkspaceRootWithFile("src/App.tsx", "app");
  const restoreHome = installHomeDirectory(workspaceRoot);
  try {
    const hostAccess = createWorkspaceFileHostAccess({
      openPath: async (targetPath) => {
        openedPaths.push(targetPath);
        return "";
      }
    });

    await hostAccess.openTerminalLink({
      cwd: path.join(workspaceRoot, "src"),
      path: "../README.md",
      workspaceID: "workspace-1"
    });
    await hostAccess.openTerminalLink({
      path: path.join(workspaceRoot, "src/App.tsx"),
      workspaceID: "workspace-1"
    });
    await hostAccess.openTerminalLink({
      path: "/tmp/demo.log",
      workspaceID: "workspace-1"
    });

    assert.deepEqual(openedPaths, [
      path.resolve(workspaceRoot, "README.md"),
      path.resolve(workspaceRoot, "src/App.tsx"),
      path.resolve("/tmp/demo.log")
    ]);
  } finally {
    restoreHome();
  }
});

test("workspace file host access reveals workspace files and directories", async () => {
  const workspaceRoot = await createWorkspaceRootWithFile("src/App.tsx", "app");
  const directoryPath = path.join(workspaceRoot, "notes");
  await mkdir(directoryPath);
  const restoreHome = installHomeDirectory(workspaceRoot);
  try {
    let revealedPath = "";
    let openedPath = "";
    const hostAccess = createWorkspaceFileHostAccess({
      openPath: async (targetPath) => {
        openedPath = targetPath;
        return "";
      },
      showItemInFolder(targetPath) {
        revealedPath = targetPath;
      }
    });

    await hostAccess.revealWorkspaceFile({
      path: "/workspace/src/App.tsx",
      workspaceID: "workspace-1"
    });
    await hostAccess.revealWorkspaceFile({
      path: "/workspace/notes",
      workspaceID: "workspace-1"
    });

    assert.equal(revealedPath, path.resolve(workspaceRoot, "src/App.tsx"));
    assert.equal(openedPath, path.resolve(workspaceRoot, "notes"));
  } finally {
    restoreHome();
  }
});

test("workspace file host access reads preview bytes under the workspace root", async () => {
  const workspaceRoot = await createWorkspaceRootWithFile(
    "notes/todo.txt",
    "ship it"
  );
  const restoreHome = installHomeDirectory(workspaceRoot);
  try {
    const hostAccess = createWorkspaceFileHostAccess({});

    const bytes = await hostAccess.readPreviewFile({
      path: path.join(workspaceRoot, "notes/todo.txt"),
      workspaceID: "workspace-1"
    });

    assert.equal(Buffer.from(bytes).toString("utf8"), "ship it");
  } finally {
    restoreHome();
  }
});

test("workspace file host access reads local text files through explicit local capability", async () => {
  const workspaceRoot = await createWorkspaceRootWithFile(
    "prompts/import.md",
    "local prompt"
  );
  const targetPath = path.join(workspaceRoot, "prompts/import.md");
  const hostAccess = createWorkspaceFileHostAccess({});

  assert.deepEqual(await hostAccess.readLocalFileText(targetPath), {
    content: "local prompt",
    name: "import.md",
    path: targetPath
  });
});

test("workspace file host access creates project directories under Documents/tutti", async () => {
  const documentsRoot = await mkdtemp(path.join(tmpdir(), "tutti-documents-"));
  const createdPaths: string[] = [];
  const hostAccess = createWorkspaceFileHostAccess({
    getDocumentsPath: () => documentsRoot,
    mkdir: async (targetPath) => {
      createdPaths.push(String(targetPath));
      await mkdir(targetPath, { recursive: true });
      return undefined;
    }
  });

  const result = await hostAccess.createUserDocumentsProjectDirectory({
    name: "Demo project"
  });

  assert.deepEqual(result, {
    path: path.join(documentsRoot, "tutti", "Demo project")
  });
  assert.deepEqual(createdPaths, [
    path.join(documentsRoot, "tutti"),
    path.join(documentsRoot, "tutti", "Demo project")
  ]);
});

test("workspace file host access rejects an existing project directory name", async () => {
  const documentsRoot = await mkdtemp(path.join(tmpdir(), "tutti-documents-"));
  await mkdir(path.join(documentsRoot, "tutti", "Demo project"), {
    recursive: true
  });
  const hostAccess = createWorkspaceFileHostAccess({
    getDocumentsPath: () => documentsRoot
  });

  await assert.rejects(
    () =>
      hostAccess.createUserDocumentsProjectDirectory({
        name: "Demo project"
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        (error as NodeJS.ErrnoException).code,
        desktopErrorCodes.projectDirectoryAlreadyExists
      );
      return true;
    }
  );
});

test("workspace file host access treats an existing directory as success when allowExisting is set", async () => {
  const documentsRoot = await mkdtemp(path.join(tmpdir(), "tutti-documents-"));
  const sessionName = "session-cf25318a-0f29-437d-943b-dfb8a478bc64";
  await mkdir(path.join(documentsRoot, "tutti", sessionName), {
    recursive: true
  });
  const hostAccess = createWorkspaceFileHostAccess({
    getDocumentsPath: () => documentsRoot
  });

  const result = await hostAccess.createUserDocumentsProjectDirectory({
    name: sessionName,
    allowExisting: true
  });

  assert.deepEqual(result, {
    path: path.join(documentsRoot, "tutti", sessionName)
  });
});

test("workspace file host access gives project-specific codes for create failures", async () => {
  const documentsRoot = await mkdtemp(path.join(tmpdir(), "tutti-documents-"));
  const hostAccess = createWorkspaceFileHostAccess({
    getDocumentsPath: () => documentsRoot,
    mkdir: async () => {
      const error = new Error("permission denied");
      (error as NodeJS.ErrnoException).code = "EACCES";
      throw error;
    }
  });

  await assert.rejects(
    () =>
      hostAccess.createUserDocumentsProjectDirectory({
        name: "Demo project"
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        (error as NodeJS.ErrnoException).code,
        desktopErrorCodes.projectDirectoryPermissionDenied
      );
      return true;
    }
  );
});

test("workspace file host access rejects project names that escape Documents", async () => {
  const documentsRoot = await mkdtemp(path.join(tmpdir(), "tutti-documents-"));
  const hostAccess = createWorkspaceFileHostAccess({
    getDocumentsPath: () => documentsRoot
  });

  for (const name of ["../outside", ""]) {
    await assert.rejects(
      () => hostAccess.createUserDocumentsProjectDirectory({ name }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(
          (error as NodeJS.ErrnoException).code,
          desktopErrorCodes.projectNameInvalid
        );
        return true;
      }
    );
  }
});

test("workspace file host access rejects missing Documents path with a project-specific code", async () => {
  const hostAccess = createWorkspaceFileHostAccess({
    getDocumentsPath: () => " "
  });

  await assert.rejects(
    () =>
      hostAccess.createUserDocumentsProjectDirectory({
        name: "Demo project"
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        (error as NodeJS.ErrnoException).code,
        desktopErrorCodes.projectDocumentsUnavailable
      );
      return true;
    }
  );
});

test("workspace file host access rejects preview files above the safe size budget", async () => {
  const largeContent = "x".repeat(workspaceFilePreviewMaxBytes + 1);
  const workspaceRoot = await createWorkspaceRootWithFile(
    "docs/large.txt",
    largeContent
  );
  const restoreHome = installHomeDirectory(workspaceRoot);
  try {
    const hostAccess = createWorkspaceFileHostAccess({});

    await assert.rejects(
      () =>
        hostAccess.readPreviewFile({
          path: path.join(workspaceRoot, "docs/large.txt"),
          workspaceID: "workspace-1"
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(
          (error as NodeJS.ErrnoException).code,
          desktopErrorCodes.previewFileTooLarge
        );
        return true;
      }
    );
  } finally {
    restoreHome();
  }
});

async function createWorkspaceRootWithFile(
  relativePath: string,
  content: string
): Promise<string> {
  const workspaceRoot = await mkdtemp(
    path.join(tmpdir(), "tutti-workspace-file-host-access-")
  );
  const absolutePath = path.join(workspaceRoot, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
  return workspaceRoot;
}

function installHomeDirectory(homeDirectory: string): () => void {
  const originalHome = process.env.HOME;
  process.env.HOME = homeDirectory;

  return () => {
    if (originalHome === undefined) {
      delete process.env.HOME;
      return;
    }
    process.env.HOME = originalHome;
  };
}

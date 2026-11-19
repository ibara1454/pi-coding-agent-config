# OpenShell verification map

Start each journey with [Launch and Doctor](../SKILL.md#launch). The prepared project has no Git metadata or secrets. Its policy grants only the project in addition to the bundled baseline. Use a separate scratch project and Pi terminal for each concurrent run.

| Journey | Entry points | Passing evidence |
| --- | --- | --- |
| [Host Bash](host-bash.md) | `!`, `!!` | Each reads a host-only marker and writes it to a different file. |
| [Model Bash and project writes](model-bash.md) | `!`, model's `bash` tool, `/sandbox` | Only host Bash sees a known file outside the mount; the model's tool writes inside the project. |
| [Missing policy](reload.md) | `/sandbox`, `/reload`, `!`, model's `bash` tool | User Bash still works; the attempted model write is rejected for the selected missing policy and creates no file. |
| [Valid read-only policy](read-only-reload.md) | `/reload`, `/sandbox`, model's `bash` tool | The same file is writable before reload, readable afterwards, and unchanged after a denied overwrite. |

With a **ready OpenShell runtime** but no model, run both host Bash prefixes and the missing-policy status and host checks. Report the model calls as unverified; a shell command or a `ready`/`blocked` status is not a substitute.

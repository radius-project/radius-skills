# Example: Todo-List-App (dockersamples/todo-list-app)

This example records the reasoning and acceptance checks rather than a complete
`app.bicep`, so its resource names and values are not copied into unrelated
applications.

## Selected profile

The requested profile runs the application with MySQL instead of its default
SQLite path. The source supports that profile when `MYSQL_HOST` is present, so
the SQLite default does not override the explicit selection.

| Acceptance criterion | Source/schema-backed decision |
|---|---|
| MySQL backing service | Emit the exact configured `Radius.Data/mySqlDatabases` type |
| Source-built workload | Use the complete Dockerfile context at an immutable source ref |
| Image tag | Set the pinned source commit as the tag because the selected Recipe's omitted-tag path is broken |
| Build platform | Override the incompatible multi-platform Recipe default with `linux/amd64` |
| Native database contract | Supply `MYSQL_HOST`, `MYSQL_USER`, `MYSQL_PASSWORD`, and `MYSQL_DB` |
| Developer-supplied credential | Set `MYSQL_PASSWORD` from the same `@secure()` password parameter via `env.value` |
| Listener | Expose the source-configured port 3000 |

## Source analysis

- **Role**: long-running Node.js/Express web service
- **Listener**: port 3000, configured by the application
- **Persistence**: SQLite by default; MySQL when `MYSQL_HOST` is present
- **Native configuration read by source**: `MYSQL_HOST`, `MYSQL_USER`,
  `MYSQL_PASSWORD`, `MYSQL_DB`
- **Backing service**: MySQL 8.0 with database `todos`
- **Image**: complete Dockerfile/build context, pinned to an immutable source commit
- **Image Recipe behavior**: its omitted-tag path fails, so the source commit is
  also the Docker-valid tag
- **Build behavior**: the Dockerfile runs Node, npm, and node-gyp in target-image
  stages and has no `BUILDPLATFORM`/`TARGETARCH` cross-build strategy, so the
  build targets only the supported `linux/amd64` deployment platform
- **Storage**: the modeled MySQL service owns persistence; no application
  filesystem volume is required
- **Primary pattern**: Web App

## Modeling decisions

1. The explicit MySQL profile selects the optional source-supported MySQL path;
   do not fall back to SQLite merely because it is the application default.
2. Resolve the MySQL type, API version, credential inputs, and `host` output
   against the exact configured extension and recipe.
3. Map the nonsecret native variables explicitly. For the credential, verify that
   the selected source path consumes the generated input Secret connection
   variable; a connection does not invent `MYSQL_PASSWORD`.
4. Store the developer-supplied password in a user-authored
   `Radius.Security/secrets` resource and connect that input Secret by `.id`.
   The generated variable suffix follows the authored Secret key. If the pinned
   source cannot consume that contract, report the contract gap rather than
   assigning the secure parameter directly to `env.value`.
5. Referencing the image and MySQL host creates dependency ordering. Keep the
   input Secret connection required for the password. Omit a separate MySQL
   producer connection unless the request explicitly requires relationship
   metadata or the source consumes its exact projection.
6. Set the image `tag` to the pinned source commit because the exact Recipe's
   omitted-tag path is broken, and set `build.platforms` to `['linux/amd64']`
   instead of inheriting its incompatible multi-platform default. Consume the
   source build through the verified `properties.imageReference`.
7. Verify that the target Environment registers Recipes for MySQL,
   containerImages, and containers.
8. Match `containerPort` to the inspected process listener. Do not add a route
   unless external ingress is requested.

## Completion checks

- The selected MySQL type and source-built workload are both emitted.
- Every required nonsecret native variable appears with exact spelling and format.
- The workload password comes from a user-authored input Secret connection by
  `.id`; no password is hardcoded and no Recipe output is copied.
- The image has a Docker-valid immutable tag and targets only `linux/amd64`.
- The target Environment registers every Recipe required by the model.
- The process listener, image entrypoint, and database name/version agree with
  the pinned source.
- The definition compiles against the exact configured extension and has no
  unresolved runtime caveat.

# kjobs MVP 基本設計

文書状態: MVP実装の設計基準  
版: 0.1  
基準日: 2026-08-02  
対応要件: `docs/requirements.md`  
対象計画: `plans/mvp.pert` の `BASIC_DESIGN`

## 1. 設計目標

`kjobs` は、一つのローカルCLIプロセスが、宣言的なジョブ定義を読み、`perttool` の開始許可に従ってシェルジョブを実行し、途中状態と履歴をプロジェクト内へ永続化する構成とする。

MVPでは次を重視する。

- 利用者が理解できる小さなCLIと一つの設定ファイル
- プロセス異常終了後にも判定可能な実行記録
- 優先順位ロジックを複製しない `perttool` 連携
- 本体、再試行、復旧を区別できる状態機械
- テキスト出力とJSON出力が共有するアプリケーション結果型

## 2. 採用する設計判断

| ID | 判断 | 理由 |
| --- | --- | --- |
| `KJ-AD-001` | TypeScript、ESM、Node.js 22以上を使用する | `perttool 0.5.0` と同じランタイムでCore APIを直接利用するため |
| `KJ-AD-002` | 常駐デーモンを置かない | 単一ホストMVPの導入・障害解析・権限境界を単純にするため |
| `KJ-AD-003` | `kjobs.yaml` を唯一のジョブ定義とする | `.pert` との二重管理を避けるため |
| `KJ-AD-004` | 状態は `.kjobs/` のバージョン付きJSONと追記ログへ保存する | SQLiteやネイティブ依存なしで、内容を検査・回収可能にするため |
| `KJ-AD-005` | 一つのプロジェクト更新ロックでスケジューリングと状態更新を直列化する | 二重開始とロストアップデートを防ぐため |
| `KJ-AD-006` | シェルジョブは独立したプロセスグループで起動する | タイムアウトとキャンセルを子孫プロセスへ伝播するため |
| `KJ-AD-007` | `perttool` へGrammar 5文書文字列をメモリ上で投影する | 現行公開APIが文書文字列を受け取り、構造化入力APIを要求しないため |
| `KJ-AD-008` | YAMLテンプレート式は `${{ inputs.NAME }}` の完全値置換だけを許す | 任意式評価と文字列注入の範囲を抑えるため |
| `KJ-AD-009` | JSON出力はドメイン結果から生成し、端末表示から再解析しない | 自動化向け契約を安定させるため |
| `KJ-AD-010` | MVPの排他は単一ホスト・単一ファイルシステムを前提とする | 分散ロックをMVP範囲へ持ち込まないため |

## 3. システム構成

```text
CLI adapter
  |
  v
Application services
  |-- definition service ---- YAML parser / schema validator
  |-- scheduler ------------ PriorityProvider (perttool adapter)
  |-- execution coordinator - process runner / retry / recovery
  |-- query service --------- status / history / progress
  |
  v
Repository ports
  |-- DefinitionRepository -- kjobs.yaml (read-only during runs)
  |-- StateRepository ------ .kjobs/state.json
  |-- RunRepository -------- .kjobs/runs/<run-id>/
  |-- ProjectLock ---------- .kjobs/lock
```

依存方向はCLIおよびI/Oアダプターからアプリケーション・ドメインへ向ける。ドメイン層はファイルシステム、時計、プロセス、端末、`perttool` の具体実装を直接参照しない。

### 3.1 モジュール境界

| ディレクトリ | 責務 |
| --- | --- |
| `src/cli/` | 引数解析、終了コード、テキスト/JSON出力 |
| `src/application/` | コマンド単位のユースケースとトランザクション境界 |
| `src/domain/` | ジョブ、Run、状態遷移、再試行・復旧規則、結果型 |
| `src/config/` | YAML読込、スキーマ検証、テンプレート展開 |
| `src/priority/` | `PriorityProvider` とperttoolアダプター |
| `src/execution/` | 子プロセス、シグナル、タイムアウト、ログストリーム |
| `src/storage/` | ロック、原子的JSON、Runディレクトリ、回収 |
| `src/presentation/` | 同じ結果型からのテキスト/JSON投影 |
| `test/` | 単体・統合・CLI E2Eテスト |

## 4. 設定ファイル

既定ファイル名はプロジェクトルートの `kjobs.yaml` とする。ルートは、明示された `--file`、現在ディレクトリから上位へ探索した `kjobs.yaml` の順で決める。

### 4.1 YAMLスキーマ v1

```yaml
schema_version: 1

project:
  id: example
  max_parallel: 1
  shell: /bin/sh
  state_dir: .kjobs

templates:
  node-task:
    inputs:
      script:
        type: string
        required: true
    command: "npm run ${{ inputs.script }}"
    timeout: 10m
    retry:
      max_attempts: 2
      delay: 5s
      backoff: fixed

jobs:
  test:
    template: node-task
    with:
      script: test
    description: Run tests
    cwd: .
    needs: [build]
    priority: 10
    estimate: 5p
    resources:
      cpu: 1
    env:
      NODE_ENV: test
    inherit_env: [PATH, HOME]
    timeout: 15m
    success_exit_codes: [0]
    retry:
      max_attempts: 3
      delay: 5s
      backoff: exponential
      max_delay: 1m
      on_exit_codes: [1, 75]
    recovery:
      command: npm run clean
      timeout: 2m
      on_success: retry

resources:
  cpu:
    capacity: 2
```

### 4.2 値の規則

- `schema_version` は必須で、MVPでは整数 `1` のみを受理する。
- `project.id` とジョブ、テンプレート、リソースのIDは `[A-Za-z][A-Za-z0-9_-]{0,63}` とする。
- `jobs` は一件以上を要求する。
- ジョブは展開後に非空の `command` を一つ持つ。
- `needs` は既知のジョブだけを参照し、自己参照と循環を禁止する。
- `priority` は符号付き32ビット整数、既定値は `0` とする。
- `estimate` は正のperttool Durationとし、MVPのプロジェクト単位はPointとする。
- `max_parallel`、リソース容量、要求量は正の整数とする。要求量は容量を超えてはならない。
- 時間値は正の整数と `ms`、`s`、`m`、`h` のいずれかの接尾辞で表す。
- `success_exit_codes` の既定値は `[0]` とする。
- `retry.max_attempts` は初回を含み、既定値は `1`、上限は `100` とする。
- 未知フィールドはスキーマエラーとし、スペルミスを黙って無視しない。

### 4.3 環境変数

- 実行環境は最小限のプラットフォーム既定値、`inherit_env` で指定した名前、`env` の明示値から構成する。
- `env` は `inherit_env` より優先する。
- `inherit_env` に存在しない必須変数がある場合は起動前エラーとする。任意継承はMVPでは扱わない。
- 状態スナップショットには環境変数名と値の由来だけを保存し、継承値は保存しない。
- `env` の値は定義ファイルの一部として信頼するが、CLI診断とRunメタデータでは値をマスクする。

### 4.4 テンプレート

- テンプレートは一つのジョブから一つだけ参照でき、テンプレートが別テンプレートを参照することは禁止する。
- `with` は宣言済み入力だけを指定できる。
- 入力型はMVPでは `string`、`integer`、`boolean` とする。
- `${{ inputs.NAME }}` はYAMLスカラー全体または文字列内で置換できるが、式、関数、環境変数参照は評価しない。
- 展開順は、テンプレート既定値、入力置換、ジョブ側フィールドによる上書き、最終スキーマ検証とする。
- `kjobs job show` と `--dry-run` は展開後の実効定義を返す。

## 5. ドメインモデル

### 5.1 JobDefinition

```ts
interface JobDefinition {
  id: string;
  command: string;
  description?: string;
  cwd: string;
  shell: string;
  needs: readonly string[];
  priority: number;
  estimate: string;
  resources: ReadonlyMap<string, number>;
  env: ReadonlyMap<string, string>;
  inheritEnv: readonly string[];
  timeoutMs?: number;
  successExitCodes: ReadonlySet<number>;
  retry: RetryPolicy;
  recovery?: RecoveryPolicy;
}
```

### 5.2 RunとAttempt

一回の `kjobs run` により対象ジョブへ `Run` を一つ作る。初回と再試行は同じRun配下の個別 `Attempt` とする。復旧コマンドは失敗Attemptに関連付く `RecoveryAttempt` とする。

```ts
interface Run {
  schemaVersion: 1;
  runId: string;
  jobId: string;
  definitionDigest: string;
  state: RunState;
  attempts: readonly AttemptSummary[];
  createdAt: string;
  updatedAt: string;
  terminalReason?: TerminalReason;
}
```

Run IDは、時刻順に並べられ衝突しないUUID v7とする。状態判定にディレクトリ名や端末表示を使わない。

## 6. 状態機械

### 6.1 集約ジョブ状態

集約状態は保存された最新Runと依存関係から導出する。

```text
no run ------------------------> pending
pending + dependencies met ----> ready
latest run running ------------> running
latest run retry_wait ---------> retry_wait
latest run recovering ---------> recovering
latest run succeeded ----------> succeeded
latest run failed -------------> failed
dependency terminal failure ---> blocked
latest run canceled -----------> canceled
explicit skip -----------------> skipped
```

`ready` と `blocked` はジョブ定義と保存状態から導出し、Runの永続状態にはしない。Runの状態は次とする。

```ts
type RunState =
  | "created"
  | "running"
  | "recovering"
  | "retry_wait"
  | "succeeded"
  | "failed"
  | "canceled"
  | "interrupted";
```

### 6.2 本体、復旧、再試行

```text
created -> running
running --success------------------------------> succeeded
running --failure, retry unavailable-----------> failed
running --failure, recovery configured---------> recovering
recovering --failure----------------------------> failed
recovering --success, on_success=fail-----------> failed
recovering --success, retry available-----------> retry_wait
running --failure, no recovery, retry available-> retry_wait
retry_wait --delay elapsed----------------------> running
non-terminal --cancel---------------------------> canceled
orphaned non-terminal --------------------------> interrupted
```

- 復旧成功は元のAttemptを成功へ変更しない。
- `on_success=retry` でも上限到達後は再試行せず `failed` とする。
- バックオフは `fixed` または `exponential` とし、指数は `delay * 2^(attempt-1)`、`max_delay` で上限を設ける。
- 再試行可否は終了理由、`on_exit_codes`、残り試行回数のすべてで決める。
- 実行スロットと宣言リソースは `running` と `recovering` の間保持し、`retry_wait` で解放する。
- `retry_wait` のジョブは待機期限までStartable候補から除外する。

## 7. 実行設計

### 7.1 起動

プロセスランナーは `shell -c <command>` を、ジョブの作業ディレクトリ、構成済み環境、独立プロセスグループで起動する。シェルパスと作業ディレクトリは起動前に検証する。

実行コーディネーターは次の順で処理する。

1. 定義と状態を読み、孤児Runを回収する。
2. プロジェクトロック内で開始許可と容量を再評価する。
3. RunとAttemptを `created` として原子的に保存する。
4. 子プロセスを起動し、PIDとプロセス開始識別情報を保存して `running` にする。
5. stdout/stderrを端末と別々のログファイルへ同時に流す。
6. 終了結果をfsync後に保存し、次の状態を決定する。
7. 端末状態になったらリソースリースを解放する。

### 7.2 シグナルとタイムアウト

- Ctrl-C、`kjobs cancel`、タイムアウトでは、まずプロセスグループへ `SIGTERM` を送る。
- 設定可能な猶予時間後も存在する場合は `SIGKILL` を送る。
- PID再利用による誤停止を防ぐため、保存したPIDだけでなくプロセス開始識別情報を照合する。
- シグナル送信の成否と最終終了理由をRunイベントへ記録する。
- CLI自身が停止しても、次回コマンドが非端末Runと生存プロセスを照合し、死亡済みなら `interrupted` とする。

### 7.3 終了理由

```ts
type TerminalReason =
  | { kind: "exit"; code: number }
  | { kind: "signal"; signal: string }
  | { kind: "timeout" }
  | { kind: "spawn_error"; code?: string }
  | { kind: "recovery_failed" }
  | { kind: "canceled" }
  | { kind: "orphaned" };
```

## 8. 優先順位設計

### 8.1 境界

```ts
interface PriorityProvider {
  select(input: PriorityInput): Promise<PriorityResult>;
}

interface PriorityResult {
  complete: boolean;
  readyJobIds: readonly string[];
  recommendedJobIds: readonly string[];
  startableRecommendedJobIds: readonly string[];
  blocked: readonly BlockedJob[];
  reasons: ReadonlyMap<string, readonly PriorityReason[]>;
  sourceDigest: string;
  diagnostics: readonly PriorityDiagnostic[];
}
```

スケジューラーは `complete === true` の `startableRecommendedJobIds` だけをID省略時の自動開始対象にする。ReadyやRecommendedだけから開始許可を推測しない。

### 8.2 perttool投影

アダプターは実効ジョブ定義と状態の一スナップショットから決定的なGrammar 5文書を生成し、`selectNextTasks` を呼ぶ。

| kjobs | perttool |
| --- | --- |
| project ID | project ID |
| job ID | task ID |
| `needs` | 中間milestoneを介した依存DAG |
| `estimate` | task duration |
| `priority` | task priority |
| resources | renewable resources / requirements |
| succeeded | done/reached closure |
| running、recovering | active |
| retry_wait | suspended相当として推薦対象外 |
| failed、canceled、interrupted | blocked |
| pending、ready | planned |

- 投影文書は一時ファイルとして保存せず、デバッグ出力でも秘密値やコマンド本文を含めない。
- 生成順はIDのコードポイント順とし、同じ入力から同じ文書ダイジェストを得る。
- `perttool` の診断、不完全結果、未知のスキーマ版は自動選択失敗とする。
- 明示ジョブIDによる `run` でも依存、重複実行、容量を検証する。これらを無視する強制オプションはMVPに設けない。

### 8.3 並列選択

- `project.max_parallel` から現在の `running` と `recovering` を引いた数を空きスロットとする。
- `startableRecommendedJobIds` の順を保持し、空きスロット数まで開始する。
- 各開始直前にロック内で状態と容量を再確認する。
- 一件の起動失敗は他の既に許可されたジョブを取り消さないが、新たな選択前に状態を再投影する。

## 9. 永続化設計

```text
.kjobs/
  lock
  state.json
  events.jsonl
  runs/
    <run-id>/
      run.json
      definition.json
      stdout.log
      stderr.log
      attempts/
        <attempt-number>.json
        <attempt-number>-recovery.json
```

### 9.1 原子的更新

JSON更新は同じディレクトリに排他的な一時ファイルを作成し、書込み、ファイルfsync、rename、親ディレクトリfsyncの順で行う。`state.json` はキャッシュ可能な現在状態、`events.jsonl` とRunディレクトリは履歴の証跡とする。

ロック取得は排他的作成を用い、所有PID、プロセス開始識別情報、取得時刻、CLI invocation IDを保存する。既存所有者が生存している場合は待機または競合終了し、死亡済みの場合だけ回収する。

### 9.2 整合性

- `state.json`、`run.json`、JSON出力はそれぞれ `schema_version` を持つ。
- Run作成時に展開済み定義の正規JSONとSHA-256を保存する。
- 履歴照会はRunディレクトリを正とし、`state.json` 不整合時は再構築できるようにする。
- 末尾が不完全な `events.jsonl` レコードは無視して診断し、既存レコードを書き換えない。
- `.kjobs/` は秘密ストアではない。コマンドと明示設定値を保存するため、プロジェクト所有者だけが読める権限で作成する。

## 10. CLI設計

### 10.1 共通規則

- 形式は `kjobs <resource> <action> [operands] [options]` を基本とする。
- 共通オプションは `--file <path>`、`--format text|json`、`--color auto|always|never` とする。
- JSON出力時は色情報や進捗アニメーションを出さず、stdoutにはJSON文書一つだけを出す。
- 診断はテキスト時はstderr、JSON時は結果の `diagnostics` に含める。
- `--help` と利用誤りはジョブ定義や状態を変更しない。

### 10.2 コマンドとアプリケーションサービス

| コマンド | サービス | 副作用 |
| --- | --- | --- |
| `init` | InitializeProject | `kjobs.yaml` の排他的作成 |
| `validate` | ValidateDefinition | なし |
| `job list/show` | QueryJobs | なし |
| `next` | SelectNextJobs | 孤児回収を除きなし |
| `run [job-id]` | RunJobs | Run作成とプロセス実行 |
| `status` | QueryStatus | 孤児回収を除きなし |
| `history` | QueryHistory | なし |
| `retry <job-id>` | RetryJob | 新しいRunを作成 |
| `cancel <job-id>` | CancelJob | シグナル送信と状態更新 |
| `template list/show` | QueryTemplates | なし |
| `template apply` | RenderTemplate | 既定は表示、明示出力時のみファイル作成 |

`run --dry-run` は定義展開、状態回収、優先順位計算まで行うが、Run作成、ロック保持、子プロセス起動を行わない。

### 10.3 終了コード

| Code | 意味 |
| --- | --- |
| `0` | 要求された操作が成功 |
| `1` | 定義、状態、優先順位、ジョブ実行のドメイン失敗 |
| `2` | CLI利用誤り |
| `3` | 入出力、エンコーディング、保存失敗 |
| `4` | ロック競合または同時実行競合 |
| `5` | キャンセルまたはタイムアウト |
| `70` | 内部不変条件違反 |

ジョブの非ゼロ終了は、許容終了コードでない限りCLI終了コード `1` に正規化し、元の終了コードは構造化結果へ保持する。

## 11. 表示とJSON契約

全CLI結果は次の共通包絡を持つ。

```ts
interface CliResult<T> {
  schema_version: "Kjobs.CliResult.v1";
  tool_version: string;
  operation: string;
  ok: boolean;
  project_id: string | null;
  definition_digest: string | null;
  data: T | null;
  diagnostics: readonly Diagnostic[];
}
```

- テキスト表示はこの結果から生成し、別の状態判定を行わない。
- `status` は状態別件数、実行中、次候補、失敗、ブロック、件数進捗を返す。
- 時間加重進捗は推定値であることを `estimated: true` として返す。
- `history` は新しいRunから順にページング可能とし、既定件数を50とする。
- ログ本文は既定の `history` JSONへ埋め込まず、明示要求時だけ制限付きで取得する。

## 12. エラーと診断

診断は安定したコード、重大度、短いメッセージ、任意のYAML位置、関連ID、回復案を持つ。

| Prefix | 分類 |
| --- | --- |
| `KJCLI` | CLI利用 |
| `KJCFG` | YAML、スキーマ、テンプレート |
| `KJPRI` | 優先順位投影とperttool結果 |
| `KJRUN` | 起動、終了、タイムアウト、シグナル |
| `KJREC` | 再試行と復旧 |
| `KJSTO` | ロック、状態、履歴、回収 |

秘密値、完全な環境、外部入力由来の未処理文字列を診断へ含めない。

## 13. テスト戦略

### 13.1 単体テスト

- YAMLスキーマと未知フィールド
- DAG循環、未知依存、リソース量
- テンプレート入力、置換、上書き、循環禁止
- Run状態遷移と不正遷移
- 再試行回数、固定/指数バックオフ、復旧分岐
- kjobs状態からGrammar 5への決定的投影
- JSON結果とテキスト表示の共通結果

### 13.2 統合テスト

- 一時ディレクトリ上の原子的保存とロック競合
- stdout/stderrストリーム、終了コード、タイムアウト
- プロセスグループのキャンセル
- 異常終了を模した孤児Run回収
- 実パッケージ `perttool` によるReady/Recommended/Startable判定

### 13.3 E2E受け入れ

`docs/requirements.md` の `AC-01` から `AC-10` を、インストールされた `kjobs` CLIと隔離した一時プロジェクトで検証する。JSON Schema成果物はMVP実装中にCLI結果と設定形式それぞれへ用意する。

## 14. 要件トレーサビリティ

| 要求 | 主な設計節 |
| --- | --- |
| `KJ-FR-001`, `KJ-FR-002` | 4, 10 |
| `KJ-FR-003` | 7 |
| `KJ-FR-004`, `KJ-FR-005`, `KJ-FR-011` | 8 |
| `KJ-FR-006` | 5, 9 |
| `KJ-FR-007` | 6 |
| `KJ-FR-008` | 4.4 |
| `KJ-FR-009`, `KJ-FR-010` | 10, 11 |
| `KJ-FR-012` | 10.2 |
| `KJ-NFR-001`, `KJ-NFR-004`, `KJ-NFR-008` | 2, 8, 10 |
| `KJ-NFR-002`, `KJ-NFR-003`, `KJ-NFR-005`, `KJ-NFR-006` | 7, 9, 11, 12 |
| `KJ-NFR-007` | 10, 11 |

## 15. 実装順序への制約

1. `PROJECT_FOUNDATION` で型、設定検証、結果包絡、ストレージポートを確立する。
2. `EXECUTION_ENGINE` で状態機械、原子的保存、ロック、子プロセス実行を完成させる。
3. `PERTTOOL_INTEGRATION` で投影と開始許可を接続する。接続前に独自順位計算を公開しない。
4. `RECOVERY_TEMPLATES` で再試行、復旧、テンプレートを完成させる。
5. `CLI_OBSERVABILITY` で全コマンド、テキスト/JSON、進捗、履歴を公開する。
6. `MVP_ACCEPTANCE` でAC-01からAC-10とインストール済み動作を受け入れる。

## 16. MVP後へ延期する事項

- SQLiteまたは外部データベースへの状態バックエンド
- 常駐デーモン、リモート実行、分散ロック
- Windowsネイティブプロセス管理
- cron、イベントトリガー、Web UI
- 複数テンプレート継承、任意式、プラグイン実行
- 外部秘密ストアの直接統合
- `@perttool/core` の別パッケージ化
- 依存やリソース制約を無視する強制実行

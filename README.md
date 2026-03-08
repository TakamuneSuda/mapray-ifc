# mapray-ifc

`mapray-ifc` は、IFC ファイルを `web-ifc` で解析し、`Mapray` の scene に表示するためのライブラリです。  
既存の `mapray.Viewer` または `@mapray/ui` の `StandardUIViewer` に後付けで組み込み、次のような用途を想定しています。

- IFC を読み込んで Mapray 上に表示する
- 地理座標に合わせてモデル全体を配置する
- クリックした `ModelEntity` から IFC 要素情報を引き当てる
- IFC の基本属性をアプリ側 UI に表示する

このリポジトリには sample UI も含まれていますが、ライブラリ本体は `src/lib` 配下です。  
`src/routes` 配下は動作確認用のサンプルであり、公開 API には含めません。

## デモ

- デモ URL: `https://takamunesuda.github.io/mapray-ifc/`

## 位置づけ

- ライブラリ本体: `src/lib`
- sample UI: `src/routes`
- package 出力先: `dist`

## できること

- `File` / `Blob` / `ArrayBuffer` から IFC を読み込む
- `web-ifc` の解析結果を chunk 化した glTF として Mapray scene に流し込む
- IFC 全体に対して `longitude` / `latitude` / `height` / `heading` / `tilt` / `roll` / `scale` を適用する
- 画面上のクリック位置から IFC 要素を逆引きする
- IFC 要素の基本属性を取得する
- 読み込み時間や要素数などのメトリクスを取得する

## 前提と制約

このライブラリは次の前提で作っています。

- 利用側アプリで `@mapray/mapray-js` を利用していること
- `module worker` を使えること
- `web-ifc.wasm` を読み込めること
- `new URL(..., import.meta.url)` や `?url` import を扱える bundler であること

現時点で検証しているのは Vite 系の構成です。  
Webpack、Next.js、独自 bundler などは未検証です。

また、IFC の解析は常に Worker で行います。  
main thread fallback は提供していません。

`@mapray/mapray-js` は peer dependency として扱っています。  
このパッケージ単体では Viewer を生成せず、利用側が持つ `mapray.Viewer` に後付けで接続します。

## エントリポイント

```ts
import { MaprayIfcController } from 'mapray-ifc';
```

型も同じエントリから利用できます。

```ts
import type {
	IfcElementMetadata,
	IfcModelTransform,
	MaprayIfcLoadResult,
	MaprayIfcPickResult
} from 'mapray-ifc';
```

## 最小の使い方

`@mapray/ui` の `StandardUIViewer` を使う例です。

```ts
import mapray from '@mapray/mapray-js';
import maprayui from '@mapray/ui';
import { MaprayIfcController } from 'mapray-ifc';

const stdViewer = new maprayui.StandardUIViewer(container, accessToken);

const ifcController = new MaprayIfcController({
	mapray,
	viewer: stdViewer.viewer,
	onProgress: (message) => {
		console.log(message);
	}
});

const file = input.files?.[0];
if (!file) {
	throw new Error('IFC ファイルが選択されていません。');
}

const result = await ifcController.load(file);

ifcController.setTransform({
	longitude: 138.72884,
	latitude: 35.36423,
	height: 0,
	heading: 0,
	tilt: 0,
	roll: 0,
	scale: 1
});

console.log(result.stats.elementCount);
```

## 典型的な実装手順

アプリ側では次の順で組み込むと扱いやすいです。

1. Mapray Viewer を初期化する
2. `MaprayIfcController` を 1 インスタンス作る
3. ユーザーが選んだ IFC を `load()` する
4. 読み込み完了後に `setTransform()` で配置する
5. canvas click で `pick()` を呼び、属性 UI に表示する
6. 画面破棄時に `destroy()` を呼ぶ

## API

### `new MaprayIfcController(options)`

既存の `mapray.Viewer` に IFC ローダを接続します。

```ts
const controller = new MaprayIfcController({
	mapray,
	viewer: stdViewer.viewer
});
```

#### `options.mapray`

`@mapray/mapray-js` の default export を渡します。

#### `options.viewer`

IFC を追加する対象の `mapray.Viewer` インスタンスです。

#### `options.onProgress?`

Worker 内の進捗通知を受けるコールバックです。  
現在は主に次のような文言が渡されます。

- `Parsing IFC with web-ifc...`
- `Converting IFC mesh to glTF...`

#### `options.workerFactory?`

独自 Worker を差し込みたいときに使います。  
通常のアプリ利用では不要で、テストや特殊な実行環境向けのオプションです。

#### `options.modelOffsetTilt?`

IFC と glTF の軸差を補正するための tilt 値です。既定値は `-90` です。  
標準的な利用では変更しなくて構いません。

#### `options.boundsEpsilon?`

pick 時の bbox 判定に使う許容値です。既定値は `0.05` です。  
クリック判定が厳しすぎる場合の微調整用です。

#### `options.wasmPath?`

`web-ifc.wasm` を配信している場所を指定します。  
未指定時は bundler が解決した `web-ifc.wasm` の位置から自動的に決まります。

指定できる値の例:

- wasm ディレクトリ URL  
  例: `https://example.com/assets/`
- wasm ファイル URL  
  例: `https://example.com/assets/web-ifc.wasm`

### `await controller.load(source, options?)`

IFC を読み込み、Mapray scene に追加します。  
解析は Worker で行われます。

```ts
const result = await controller.load(file);
```

#### `source`

次のいずれかを受け取ります。

- `File`
- `Blob`
- `ArrayBuffer`

#### `options.fileSizeBytes?`

`source` が `ArrayBuffer` のときに元ファイルサイズを明示したい場合に使います。  
`File` / `Blob` では自動的に `size` が使われます。

#### 戻り値 `MaprayIfcLoadResult`

```ts
type MaprayIfcLoadResult = {
	stats: ExtractedModelStats;
	elements: IfcElementMetadata[];
	metrics: IfcProcessingMetrics;
	maprayLoadMs: number;
	totalLoadMs: number;
	loadedEntityCount: number;
	chunkCount: number;
	sceneResourceCount: number;
	sceneBinaryBytes: number;
	fileSizeBytes: number | null;
};
```

主な項目:

- `stats.elementCount`: IFC 要素数
- `stats.meshCount`: メッシュ数
- `stats.vertexCount`: 頂点数
- `stats.triangleCount`: 三角形数
- `stats.bounds`: 解析モデル全体の bounds
- `metrics.parseIfcMs`: `web-ifc` 解析時間
- `metrics.gltfTransformMs`: glTF 変換時間
- `metrics.totalMs`: Worker 内処理時間
- `maprayLoadMs`: `SceneLoader` が scene に反映するまでの時間
- `totalLoadMs`: `load()` 全体の経過時間
- `loadedEntityCount`: scene に追加された `ModelEntity` 数
- `chunkCount`: IFC を分割した chunk 数
- `sceneResourceCount`: scene resource 数
- `sceneBinaryBytes`: glTF 関連 binary の合計サイズ

#### 例外

次のような場合は `load()` が例外を投げます。

- 同時に 2 回 `load()` した
- Worker が起動できなかった
- IFC の解析に失敗した
- `SceneLoader` への反映に失敗した

失敗時は、途中まで追加された entity を残さないように後始末します。

### `controller.setTransform(transform)`

読み込み済み IFC 全体の配置を更新します。

```ts
controller.setTransform({
	longitude: 139.75,
	latitude: 35.68,
	height: 10,
	heading: 90,
	tilt: 0,
	roll: 0,
	scale: 1
});
```

`transform` に指定できる項目:

- `longitude`
- `latitude`
- `height`
- `heading`
- `tilt`
- `roll`
- `scale`

一部だけを渡すこともできます。

```ts
controller.setTransform({
	height: 25,
	scale: 0.5
});
```

### `controller.pick(screenPoint)`

画面上の座標から IFC 要素を逆引きします。

```ts
const rect = canvas.getBoundingClientRect();
const hit = controller.pick([event.clientX - rect.left, event.clientY - rect.top]);

if (hit.element) {
	console.log(hit.element.name);
}
```

#### 引数

- `screenPoint[0]`: canvas 左上基準の x
- `screenPoint[1]`: canvas 左上基準の y

#### 戻り値 `MaprayIfcPickResult`

```ts
type MaprayIfcPickResult = {
	element: IfcElementMetadata | null;
	entity: ModelEntity | null;
	worldPosition: [number, number, number] | null;
	elapsedMs: number;
};
```

補足:

- IFC 未ロード時は常に `element: null`
- IFC 以外をクリックした場合も `element: null`
- `worldPosition` は GOCS 座標

### `controller.pickModelEntity(screenPoint)`

IFC 要素の逆引きまでは不要で、Mapray の `ModelEntity` だけ取得したい場合に使います。

### `controller.getCurrentOriginGocs()`

現在の IFC 原点を GOCS 座標で返します。  
まだ transform が設定されていない場合でも、現在の内部状態から計算した値を返します。

### `controller.moveToGocsPosition(position)`

GOCS 座標で IFC 原点を移動します。  
内部的には `longitude` / `latitude` / `height` へ変換して `setTransform()` します。

### `controller.unload()`

読み込み済み IFC を scene から外します。  
進行中の読み込みがあればキャンセルも試みます。

### `controller.destroy()`

`unload()` に加えて Worker を terminate します。  
viewer の破棄やコンポーネント unmount のときはこちらを呼んでください。

## 返ってくる IFC 情報

### `IfcElementMetadata`

`pick()` や `load()` の結果に含まれる要素情報です。

```ts
type IfcElementMetadata = {
	expressID: number;
	entityId: string;
	type: string;
	globalId: string | null;
	name: string | null;
	description: string | null;
	objectType: string | null;
	tag: string | null;
	predefinedType: string | null;
	bounds: IfcElementBounds | null;
};
```

## 実装上の挙動

- IFC 解析は `web-ifc` で行う
- 解析結果は chunk 化した glTF に変換する
- 描画は `Mapray.SceneLoader` を使う
- 要素 pick は `Mapray pick -> chunk entity -> bbox ベース逆引き` で解決する
- Worker がネイティブ `error` を起こした場合は破棄し、次回 `load()` で作り直す

## 利用時の注意

### 1. カメラは自動では動かない

`setTransform()` はモデルを動かす API であり、カメラは動かしません。  
読み込み後に対象位置へ寄せたい場合は、consumer 側で Mapray の camera 制御を行ってください。

### 2. `pick()` は canvas 座標を渡す

ページ全体の座標ではなく、canvas 左上基準の座標を渡してください。

### 3. 連続ロードは直列化されない

同時に 2 回 `load()` すると例外になります。  
アプリ側では、読み込み中のボタン無効化などを行うのが扱いやすいです。

### 4. bundler 依存がある

この package は Worker と wasm asset の解決に bundler 機能を使います。  
Vite 互換以外で使う場合は、Worker と wasm の解決結果を必ず確認してください。

## sample UI

リポジトリ内の sample UI を起動する場合:

```sh
pnpm install
cp .env.example .env.local
pnpm dev
```

`.env.local` には少なくとも次を設定します。

```sh
VITE_MAPRAY_ACCESS_TOKEN=your-mapray-access-token
```

sample UI では `sample_ifc/*.ifc` を静的配信するため、Vite 側で copy 設定を入れています。  
これは sample 用の都合であり、library API の利用条件そのものではありません。

## 開発用コマンド

```sh
pnpm test
pnpm check
pnpm lint
pnpm build
pnpm build:lib
pnpm check:package
```

## 現状のサポート範囲

- `mapray.Viewer` への IFC 表示追加
- `@mapray/ui` の `StandardUIViewer` と組み合わせた利用
- Vite 系 bundler
- Worker / wasm が使えるブラウザ環境

未対応または未検証:

- npm registry 公開
- Vite 以外の bundler での正式サポート
- Worker を使えない環境向け fallback

# mapray-ifc

`web-ifc` で IFC を解析し、`Mapray` の `SceneLoader` へ chunk 化した glTF を流し込むための実装です。

このリポジトリには 2 つあります。両者は分けて扱います。

- サンプル UI: `src/routes/+page.svelte`
- ライブラリ API: `src/lib/mapray-ifc-controller.ts`

目的は、既存の `Mapray Viewer` / `StandardUIViewer` に対して IFC 表示と要素 pick を後付けできることです。

## Public API

公開エントリは `src/lib/index.ts` です。`pnpm build:lib` で `dist/` に package 用の出力を生成できます。`package.json` はまだ `private: true` なので npm registry 公開用ではありませんが、workspace 参照や `pnpm pack` した tarball からはライブラリとして利用できます。`src/routes` 配下の UI は sample 専用であり、library API には含めません。

```ts
import { MaprayIfcController } from 'mapray-ifc';
```

### `new MaprayIfcController(options)`

既存の `mapray.Viewer` に IFC ローダを接続します。

```ts
const controller = new MaprayIfcController({
	mapray,
	viewer: stdViewer.viewer,
	onProgress: (message) => console.log(message)
});
```

`options`:

- `mapray`: `@mapray/mapray-js` の default export
- `viewer`: 既存の `mapray.Viewer` インスタンス
- `onProgress?`: Worker 内の進捗通知 callback
- `workerFactory?`: 独自 Worker を注入したい場合の factory
- `modelOffsetTilt?`: IFC/glTF の軸差分補正。既定値は `-90`
- `boundsEpsilon?`: bbox pick 補正。既定値は `0.05`
- `wasmPath?`: `web-ifc` wasm を配信しているディレクトリ URL。未指定時は bundler が解決した `web-ifc.wasm` の位置から自動設定

このライブラリは常に module worker と `web-ifc.wasm` を使って IFC を処理します。main thread fallback は提供しません。

### `await controller.load(source, options?)`

IFC を Worker で解析し、Mapray scene に追加します。

```ts
const result = await controller.load(file);
```

`source`:

- `File`
- `Blob`
- `ArrayBuffer`

戻り値 `MaprayIfcLoadResult`:

- `stats`: 要素数、三角形数、bounds
- `elements`: pick 可能な IFC 要素メタデータ
- `metrics`: `parseIfcMs`, `gltfTransformMs`, `totalMs`
- `loadedEntityCount`: Mapray に追加された chunk entity 数
- `chunkCount`: chunk 数
- `sceneResourceCount`: scene resource 数
- `sceneBinaryBytes`: glTF binary 合計サイズ
- `fileSizeBytes`: 元 IFC サイズ

### `controller.setTransform(transform)`

描画済み IFC 全体の transform を更新します。

```ts
controller.setTransform({
	longitude: 138.72884,
	latitude: 35.36423,
	height: 0,
	heading: 0,
	tilt: 0,
	roll: 0,
	scale: 1
});
```

### `controller.pick(screenPoint)`

既存 Mapray canvas 上の pick 結果から IFC 要素を逆引きします。

```ts
const hit = controller.pick([x, y]);
if (hit.element) {
	console.log(hit.element.expressID, hit.element.propertyGroups);
}
```

戻り値 `MaprayIfcPickResult`:

- `element`: 解決できた IFC 要素メタデータ。無ければ `null`
- `entity`: hit した `ModelEntity`
- `worldPosition`: pick 位置の GOCS 座標
- `elapsedMs`: pick + IFC 要素逆引き時間

### `controller.pickModelEntity(screenPoint)`

Mapray の `ModelEntity` だけ欲しい場合に使います。モデル移動 UI など向けです。

### `controller.moveToGocsPosition(position)`

GOCS 座標で IFC 原点を移動します。

### `controller.getCurrentOriginGocs()`

現在の IFC 原点を GOCS で返します。

### `controller.unload()`

ロード済み IFC を scene から外します。

### `controller.destroy()`

`unload()` に加えて Worker を terminate します。

## Example

```ts
import mapray from '@mapray/mapray-js';
import maprayui from '@mapray/ui';
import { MaprayIfcController } from 'mapray-ifc';

const stdViewer = new maprayui.StandardUIViewer(container, accessToken);
const controller = new MaprayIfcController({
	mapray,
	viewer: stdViewer.viewer,
	onProgress: (message) => console.log(message)
});

await controller.load(file);
controller.setTransform({
	longitude: 138.72884,
	latitude: 35.36423,
	height: 0,
	heading: 0,
	tilt: 0,
	roll: 0,
	scale: 1
});

const canvas = stdViewer.viewer.canvas_element;
canvas.addEventListener('click', (event) => {
	const rect = canvas.getBoundingClientRect();
	const hit = controller.pick([event.clientX - rect.left, event.clientY - rect.top]);

	if (!hit.element) {
		return;
	}

	console.log(hit.element.name, hit.element.propertyGroups);
});
```

## Current Behavior

- IFC 解析は `web-ifc + Worker`
- 描画は chunk 化した glTF を `Mapray SceneLoader` で読込
- pick は `Mapray pick -> chunk entity -> bbox ベース逆引き`
- 要素属性は `IfcElementMetadata.propertyGroups` から取得

## Package Build

```sh
pnpm build:lib
pnpm pack
```

ローカル検証では、pack した tarball を別の Vite アプリへ入れて次の import が `vite build` で通ることを確認済みです。現状の package は `?url` import と module worker 解決を使うため、サポート対象は Vite 互換 bundler を前提にしています。

```ts
import { MaprayIfcController } from 'mapray-ifc';
```

ローカル consumer から使う例:

```sh
pnpm add /path/to/mapray-ifc-0.0.1.tgz
```

## Dev

```sh
pnpm install
cp .env.example .env.local
pnpm dev
pnpm test
pnpm check
pnpm lint
pnpm build
pnpm build:lib
pnpm check:package
```

`.env.local` には少なくとも次を設定してください。

```sh
VITE_MAPRAY_ACCESS_TOKEN=your-mapray-access-token
```

`pnpm build` は現在の `svelte.config.js` に従って `@sveltejs/adapter-cloudflare` 向けの成果物を生成します。

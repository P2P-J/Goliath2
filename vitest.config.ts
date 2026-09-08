import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * 테스트 설정.
 *
 * electron.vite.config.ts 와 별개로 둔다 — electron-vite 는 메인/프리로드/렌더러
 * 셋을 한꺼번에 다루는데 테스트는 그중 순수 함수만 본다.
 *
 * @shared 별칭은 두 설정이 같은 곳을 가리켜야 한다. 어긋나면 테스트만 통과하고
 * 빌드가 깨진다.
 */
export default defineConfig({
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  test: {
    // electron 을 import 하는 파일은 테스트에서 부르지 않는다.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});

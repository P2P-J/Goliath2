/** Vite 의 ?url import 를 타입스크립트에 알린다. */
declare module '*.woff2?url' {
  const url: string;
  export default url;
}

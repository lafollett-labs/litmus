// .vue files are compiled by Vite; to tsc they are components of any shape.
declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent
  export default component
}

declare module '*.css'

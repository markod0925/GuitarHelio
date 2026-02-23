declare module 'jzz-synth-tiny' {
  export function Tiny(jzz: unknown): void;
  const install: {
    (jzz: unknown): void;
    Tiny?: (jzz: unknown) => void;
  };
  export default install;
}

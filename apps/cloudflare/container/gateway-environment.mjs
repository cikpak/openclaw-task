/** Helper control-plane credentials are never inherited by the unprivileged native process. */
export function gatewayEnvironment(source = process.env) {
  const environment = Object.fromEntries(
    Object.entries(source).filter(
      ([key]) =>
        !/^(?:HELPER_|EXPECTED_MANAGER_|R2_|AWS_|CLOUDFLARE_|CF_)/.test(key) &&
        !['BOOT_ID', 'RESTORE_EXPECTED', 'RECOVERY_ROOT'].includes(key),
    ),
  );
  environment.NODE_COMPILE_CACHE = `${source.XDG_CACHE_HOME ?? '/recovery/cache'}/native-compile`;
  return environment;
}

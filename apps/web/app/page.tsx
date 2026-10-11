import styles from './page.module.css';

export default function HomePage() {
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <a className={styles.brand} href="/" aria-label="UcoNext, inicio">
          UcoNext
        </a>
        <nav className={styles.navigation} aria-label="Navegación principal">
          <a href="#operacion">Cómo empezar</a>
          <a href="/login" className={styles.loginLink}>Iniciar sesión</a>
        </nav>
      </header>

      <main className={styles.shell}>
        <section className={`${styles.introduction} uco-glass`} aria-labelledby="shell-title">
          <h1 id="shell-title">
            Gestión comercial clara, desde cualquier pantalla.
          </h1>
          <p>
            Organizá ventas, caja e inventario con una experiencia preparada para
            acompañar el ritmo de tu negocio.
          </p>
          <a className={styles.primaryLink} href="/login">Entrar a mi negocio <span aria-hidden="true">→</span></a>
        </section>
        <section className={styles.gettingStarted} id="operacion" aria-labelledby="start-title">
          <h2 id="start-title">Tu negocio, en un solo lugar.</h2>
          <p>Desde el mostrador hasta la administración, encontrá lo que necesitás para trabajar.</p>
          <dl className={styles.steps}>
            <div><dt>Elegí tu organización</dt><dd>Ingresá con tu cuenta y seleccioná el negocio y la sucursal donde vas a trabajar.</dd></div>
            <div><dt>Organizá la operación</dt><dd>Consultá el catálogo y el inventario, registrá ventas y administrá la caja.</dd></div>
            <div><dt>Revisá la actividad</dt><dd>Encontrá tus operaciones y reportes desde el menú de tu espacio de trabajo.</dd></div>
          </dl>
          <a className={styles.helpLink} href="/forgot-password">¿No podés ingresar? Recuperá tu contraseña</a>
        </section>
      </main>
    </div>
  );
}

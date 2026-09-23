import styles from './page.module.css';

export default function HomePage() {
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <a className={styles.brand} href="/" aria-label="UcoNext, inicio">
          UcoNext
        </a>
        <nav className={styles.navigation} aria-label="Navegación principal">
          <a href="#operacion">Operación</a>
          <a href="#organizacion">Organización</a>
          <a href="#ayuda">Ayuda</a>
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
        </section>
      </main>
    </div>
  );
}

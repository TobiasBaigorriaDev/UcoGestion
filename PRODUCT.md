# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Personas que operan pequeñas y medianas empresas, con roles OWNER, ADMIN, CASHIER y EMPLOYEE, principalmente durante su operación comercial diaria en computadora o teléfono.

## Product Purpose

UcoNext permite gestionar operación comercial, catálogo, inventario, caja, ventas, compras, gastos y reportes en un SaaS web/PWA multi-tenant, con continuidad limitada para POS offline.

## Positioning

Combina gestión comercial cotidiana con aislamiento multi-tenant, trazabilidad transaccional y un POS capaz de conservar operaciones offline legítimas para su sincronización segura.

## Operating Context

El producto se usa en mostrador, sucursales y administración de una PyME, en equipos de escritorio, notebooks, tablets y teléfonos; el sistema debe permitir operación por teclado y presentar estados claros y accionables.

## Capabilities and Constraints

Next.js App Router con React para web; NestJS y PostgreSQL como autoridad; las mutaciones comerciales usan la API REST bajo `/api/v1`; la interfaz es mobile-first, accesible y no transmite estados importantes solo con color.

## Brand Commitments

UcoNext usa el sistema “El Mostrador Digital de la Cordillera”, Plus Jakarta Sans, verde Bosque para acciones principales y superficies glass moderadas que degradan de forma segura en dispositivos modestos (definido en DESIGN.md).

## Evidence on Hand

El repositorio contiene el spec funcional cerrado, el plan técnico aprobado, la constitución técnica y DESIGN.md. No hay testimonios, métricas comerciales, clientes ni activos fotográficos autorizados; no se deben fabricar.

## Product Principles

- La operación diaria debe ser clara y rápida en el mostrador.
- La seguridad, el aislamiento tenant y la integridad comercial prevalecen sobre conveniencias visuales.
- La interfaz explica estados y próximos pasos sin depender solo del color.
- La experiencia principal funciona desde móvil hasta escritorio y conserva una navegación predecible.

## Accessibility & Inclusion

Contraste mínimo 4.5:1, foco visible, etiquetas y semántica accesibles, soporte de teclado y respeto por `prefers-reduced-motion` según la constitución técnica y WCAG AA.

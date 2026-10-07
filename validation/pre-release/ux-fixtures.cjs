'use strict';

// Synthetic usability/accessibility fixture projects. They are written from the
// literal contents below; nothing is downloaded, installed, built or executed.
// The same projects are used by the scripted pilot and by moderated usability
// sessions (docs/release/usability-test-kit/), so their contents are frozen per
// FIXTURE_VERSION and identified by an aggregate SHA-256.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const FIXTURE_VERSION = 1;

const orderDesk = {
  'README.md': `# Order Desk

주문 목록을 보고 주문을 취소하는 사내 도구입니다.
(Synthetic project for Code Intelligence usability sessions. Not a real product.)

## 실행 방법 (문서에 적힌 정보)

- \`./gradlew :api:bootRun\` — API 서버를 8080 포트에서 시작합니다.
- \`npm --prefix web run dev\` — 웹 화면을 시작합니다.

주문 취소는 결제 환불을 자동으로 요청합니다.
`,
  '.env': 'ORDER_DESK_SYNTHETIC_SETTING=placeholder-not-a-secret\n',
  'node_modules/left-pad/index.js': 'module.exports = function leftPad(value) { return value }\n',
  'docker-compose.yml': `services:
  api:
    build: ./api
    depends_on:
      - redis
  web:
    build: ./web
    depends_on:
      - api
  redis:
    image: redis:7
`,
  'settings.gradle': "rootProject.name = 'order-desk'\ninclude 'api', 'legacy-api'\n",
  'api/build.gradle': `plugins {
    id 'java'
    id 'org.springframework.boot' version '3.3.4'
}

dependencies {
    implementation 'org.springframework.boot:spring-boot-starter-web'
    implementation 'org.springframework.boot:spring-boot-starter-data-jpa'
    runtimeOnly 'org.postgresql:postgresql'
}
`,
  'api/src/main/resources/application.yml': `spring:
  datasource:
    url: jdbc:postgresql://orders-db:5432/orders
  data:
    redis:
      host: redis
`,
  'api/src/main/java/com/example/orderdesk/OrderDeskApplication.java': `package com.example.orderdesk;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class OrderDeskApplication {
    public static void main(String[] args) {
        SpringApplication.run(OrderDeskApplication.class, args);
    }
}
`,
  'api/src/main/java/com/example/orderdesk/order/OrderController.java': `package com.example.orderdesk.order;

import java.util.List;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/orders")
public class OrderController {

    private final OrderService orderService;

    public OrderController(OrderService orderService) {
        this.orderService = orderService;
    }

    @GetMapping
    public List<OrderEntity> list() {
        return orderService.findAll();
    }

    @GetMapping("/{orderId}")
    public OrderEntity get(@PathVariable Long orderId) {
        return orderService.find(orderId);
    }

    @PostMapping("/{orderId}/cancel")
    public OrderEntity cancel(@PathVariable Long orderId) {
        return orderService.cancel(orderId);
    }

    @GetMapping("/summary")
    public String summary() {
        return orderService.summary();
    }
}
`,
  'api/src/main/java/com/example/orderdesk/order/OrderService.java': `package com.example.orderdesk.order;

import java.util.List;
import org.springframework.stereotype.Service;

@Service
public class OrderService {

    private final OrderRepository orderRepository;
    private final OrderNotifier orderNotifier;

    public OrderService(OrderRepository orderRepository, OrderNotifier orderNotifier) {
        this.orderRepository = orderRepository;
        this.orderNotifier = orderNotifier;
    }

    public List<OrderEntity> findAll() {
        return orderRepository.findAll();
    }

    public OrderEntity find(Long orderId) {
        return orderRepository.findById(orderId).orElseThrow();
    }

    public OrderEntity cancel(Long orderId) {
        OrderEntity order = find(orderId);
        order.markCancelled();
        OrderEntity saved = orderRepository.save(order);
        orderNotifier.orderCancelled(saved);
        return saved;
    }

    public String summary() {
        return "orders=" + orderRepository.count();
    }
}
`,
  'api/src/main/java/com/example/orderdesk/order/OrderRepository.java': `package com.example.orderdesk.order;

import org.springframework.data.jpa.repository.JpaRepository;

public interface OrderRepository extends JpaRepository<OrderEntity, Long> {
}
`,
  'api/src/main/java/com/example/orderdesk/order/OrderEntity.java': `package com.example.orderdesk.order;

import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

@Entity
@Table(name = "orders")
public class OrderEntity {

    @Id
    private Long id;

    private String status;

    public Long getId() {
        return id;
    }

    public String getStatus() {
        return status;
    }

    public void markCancelled() {
        this.status = "CANCELLED";
    }
}
`,
  'api/src/main/java/com/example/orderdesk/order/OrderNotifier.java': `package com.example.orderdesk.order;

public interface OrderNotifier {
    void orderCancelled(OrderEntity order);
}
`,
  'api/src/main/java/com/example/orderdesk/order/EmailOrderNotifier.java': `package com.example.orderdesk.order;

import org.springframework.stereotype.Component;

@Component
public class EmailOrderNotifier implements OrderNotifier {
    @Override
    public void orderCancelled(OrderEntity order) {
        System.out.println("email " + order.getId());
    }
}
`,
  'api/src/main/java/com/example/orderdesk/order/SmsOrderNotifier.java': `package com.example.orderdesk.order;

import org.springframework.stereotype.Component;

@Component
public class SmsOrderNotifier implements OrderNotifier {
    @Override
    public void orderCancelled(OrderEntity order) {
        System.out.println("sms " + order.getId());
    }
}
`,
  'legacy-api/src/main/java/com/example/legacy/LegacyOrderController.java': `package com.example.legacy;

import java.util.List;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/orders")
public class LegacyOrderController {

    @GetMapping
    public List<String> list() {
        return List.of("legacy");
    }
}
`,
  'web/package.json': `{
  "name": "order-desk-web",
  "private": true,
  "version": "0.0.0",
  "dependencies": {
    "axios": "1.7.7",
    "react": "19.0.0",
    "react-dom": "19.0.0",
    "react-router-dom": "7.0.0"
  }
}
`,
  'web/src/App.tsx': `import { Route, Routes } from 'react-router-dom'
import OrderListPage from './pages/OrderListPage'
import OrderDetailPage from './pages/OrderDetailPage'

export function App() {
  return (
    <Routes>
      <Route path="/orders" element={<OrderListPage />} />
      <Route path="/orders/:orderId" element={<OrderDetailPage />} />
    </Routes>
  )
}
`,
  'web/src/pages/OrderListPage.tsx': `import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

type OrderRow = { id: number; status: string }

export default function OrderListPage() {
  const [orders, setOrders] = useState<OrderRow[]>([])
  const [summary, setSummary] = useState('')
  useEffect(() => {
    fetch('/api/orders').then((response) => response.json()).then(setOrders)
    fetch('/orders/summary').then((response) => response.text()).then(setSummary)
  }, [])
  return (
    <section>
      <h1>Orders</h1>
      <p>{summary}</p>
      <ul>
        {orders.map((order) => (
          <li key={order.id}>
            <Link to={\`/orders/\${order.id}\`}>{order.id}</Link> {order.status}
          </li>
        ))}
      </ul>
    </section>
  )
}
`,
  'web/src/pages/OrderDetailPage.tsx': `import axios from 'axios'
import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'

type OrderDetail = { id: number; status: string }

export default function OrderDetailPage() {
  const { orderId } = useParams()
  const [order, setOrder] = useState<OrderDetail | null>(null)
  useEffect(() => {
    fetch(\`/api/orders/\${orderId}\`).then((response) => response.json()).then(setOrder)
  }, [orderId])
  const cancel = async () => {
    const response = await axios.post(\`/api/orders/\${orderId}/cancel\`)
    setOrder(response.data)
  }
  return (
    <section>
      <h1>Order {order?.id}</h1>
      <p>{order?.status}</p>
      <button type="button" onClick={cancel}>Cancel order</button>
    </section>
  )
}
`,
  'scripts/export_orders.py': `"""Synthetic export script. It is documentation for the fixture and is never run."""


def export_orders(rows):
    return [row["id"] for row in rows]
`,
};

const libraryLoans = {
  'README.md': `# Library Loans

도서 대출과 반납을 처리하는 예제 서비스입니다.
(Synthetic project for Code Intelligence retest sessions. Not a real product.)

## 실행 방법 (문서에 적힌 정보)

- \`npm --prefix server run start\` — Nest 서버를 시작합니다.
- \`npm --prefix client run dev\` — 웹 화면을 시작합니다.
`,
  'server/package.json': `{
  "name": "library-loans-server",
  "private": true,
  "version": "0.0.0",
  "dependencies": {
    "@nestjs/common": "10.4.0",
    "@nestjs/core": "10.4.0",
    "@nestjs/typeorm": "10.0.2",
    "typeorm": "0.3.20"
  }
}
`,
  'server/src/loans/loan.entity.ts': `import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm'

@Entity('loans')
export class Loan {
  @PrimaryGeneratedColumn()
  id!: number

  @Column()
  title!: string

  @Column({ default: false })
  returned!: boolean
}
`,
  'server/src/loans/loans.service.ts': `import { Injectable } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { Loan } from './loan.entity'

@Injectable()
export class LoansService {
  constructor(@InjectRepository(Loan) private readonly loans: Repository<Loan>) {}

  list() {
    return this.loans.find()
  }

  async returnLoan(loanId: number) {
    const loan = await this.loans.findOneByOrFail({ id: loanId })
    loan.returned = true
    return this.loans.save(loan)
  }
}
`,
  'server/src/loans/loans.controller.ts': `import { Controller, Get, Param, Post } from '@nestjs/common'
import { LoansService } from './loans.service'

@Controller('loans')
export class LoansController {
  constructor(private readonly loansService: LoansService) {}

  @Get()
  list() {
    return this.loansService.list()
  }

  @Post(':loanId/return')
  returnLoan(@Param('loanId') loanId: string) {
    return this.loansService.returnLoan(Number(loanId))
  }
}
`,
  'client/package.json': `{
  "name": "library-loans-client",
  "private": true,
  "version": "0.0.0",
  "dependencies": {
    "react": "19.0.0",
    "react-dom": "19.0.0",
    "react-router-dom": "7.0.0"
  }
}
`,
  'client/src/routes.tsx': `import { Route, Routes } from 'react-router-dom'
import LoanListPage from './pages/LoanListPage'

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/loans" element={<LoanListPage />} />
    </Routes>
  )
}
`,
  'client/src/pages/LoanListPage.tsx': `import { useEffect, useState } from 'react'

type LoanRow = { id: number; title: string; returned: boolean }

export default function LoanListPage() {
  const [loans, setLoans] = useState<LoanRow[]>([])
  useEffect(() => {
    fetch('/loans').then((response) => response.json()).then(setLoans)
  }, [])
  const returnLoan = (loanId: number) => fetch(\`/loans/\${loanId}/return\`, { method: 'POST' })
  return (
    <ul>
      {loans.map((loan) => (
        <li key={loan.id}>
          {loan.title}
          <button type="button" onClick={() => returnLoan(loan.id)}>Return</button>
        </li>
      ))}
    </ul>
  )
}
`,
};

const FIXTURES = Object.freeze({ 'order-desk': Object.freeze(orderDesk), 'library-loans': Object.freeze(libraryLoans) });

function fixtureFiles(name) {
  assert.ok(Object.hasOwn(FIXTURES, name), 'UX_FIXTURE_UNKNOWN');
  return FIXTURES[name];
}

function fixtureDigest(name) {
  const hash = crypto.createHash('sha256');
  for (const relative of Object.keys(fixtureFiles(name)).sort()) {
    hash.update(relative + '\0').update(FIXTURES[name][relative]).update('\0');
  }
  return hash.digest('hex');
}

// Creates a new private directory; an existing destination is never reused.
function writeFixture(name, destination) {
  const files = fixtureFiles(name);
  assert.ok(path.isAbsolute(destination) && path.normalize(destination) === destination, 'UX_FIXTURE_PATH');
  fs.mkdirSync(destination, { mode: 0o700 });
  for (const relative of Object.keys(files).sort()) {
    assert.ok(!relative.startsWith('/') && !relative.split('/').includes('..'), 'UX_FIXTURE_PATH');
    const target = path.join(destination, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, files[relative], { flag: 'wx', mode: 0o600 });
  }
  return { name, version: FIXTURE_VERSION, files: Object.keys(files).length, sha256: fixtureDigest(name) };
}

module.exports = { FIXTURE_VERSION, fixtureNames: () => Object.keys(FIXTURES), fixtureFiles, fixtureDigest, writeFixture };

if (require.main === module) {
  const [command, name, destination] = process.argv.slice(2);
  if (command === '--write' && name && destination && process.argv.length === 5) {
    console.log(JSON.stringify(writeFixture(name, path.resolve(destination))));
  } else if (command === '--digest' && process.argv.length === 3) {
    console.log(JSON.stringify(Object.fromEntries(Object.keys(FIXTURES).map(key => [key, fixtureDigest(key)]))));
  } else {
    console.error('usage: node ux-fixtures.cjs --write <order-desk|library-loans> <new-directory> | --digest');
    process.exitCode = 2;
  }
}

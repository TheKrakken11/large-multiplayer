// game.js
import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';
import { GLTFLoader } from './GLTFLoader.js';
import {
  computeBoundsTree,
  disposeBoundsTree,
  acceleratedRaycast
} from './index.module.js';
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;
await new Promise((resolve, reject) => {
	const script = document.createElement('script');
	script.src = 'https://unpkg.com/peerjs@1.4.7/dist/peerjs.min.js';
	script.onload = resolve;
	script.onerror = reject;
	document.body.appendChild(script);
});

let peer;
let conn;
let isHost = false;
let myID = null;
let mySpeed = 0;
let dx = 0, dy = 0;
let mouseMoved = false;
const players = {};
const loadingTurrets = new Set();
let ground;
const connections = [];
let scene, camera, renderer;
let camEuler = new THREE.Euler(0, 0, 0, 'YXZ');
let crosshairEuler = new THREE.Euler(0, 0, 0, 'YXZ');
const raycaster = new THREE.Raycaster();
let lookTarget = new THREE.Vector3();
let crosshairLookTarget = new THREE.Vector3();
let zoom = 0;
let availableTurrets = [];
const syncedTurrets = {};
let rolling = false;
let arsenals = {};
let bullets = [];
let mouseDown = false;
let cameraLocked = false;
let crosshair;
const playerCubes = {};
const hpbars = {};
const seenBulletIds = new Set();
function random(min, max) {
	return Math.random() * (max - min) + min;
}
function randomInt(min, max) {
	return Math.floor(random(min, max));
}
function makeTree(x, y) {
	return new Promise((resolve, reject) => {
		const loader = new GLTFLoader();
		loader.load(
			'Tree.glb',
			(gltf) => {
				const tree = gltf.scene;
				tree.position.set(x, 0, y);
				tree.rotateOnWorldAxis(new THREE.Vector3(0, 1, 0), random(0, (2 * Math.PI)));
				const scale = random(0.2, 0.4);
				tree.scale.set(scale, scale, scale);
				tree.position.y = (7 - 1.2) * scale;
				resolve(tree);
			},
			undefined,
			(error) => reject(error)
		);
	});
}
function loadIt(url) {
	return new Promise((resolve, reject) => {
		const loader = new GLTFLoader();
		loader.load(
			url,
			(gltf) => {
				const obj = gltf.scene;
				resolve(obj);
			},
			undefined,
			(error) => reject(error)
		);
	});
}
async function makeTurret() {
	const top = await loadIt('turret_top.glb');
	const bottom = await loadIt('turret_bottom.glb');

	bottom.add(top); // Key fix: top becomes a child of bottom

	const turret = {
		top,
		bottom,
		off: 0.4,
		cooldown: 500,
		last: Date.now(),
		rotation: {
			x: 0,
			y: 0,
		},
		position: new THREE.Vector3(),
		updateSystem: function () {
			this.bottom.rotation.y = this.rotation.y; // Yaw on bottom
			this.top.rotation.x = this.rotation.x;    // Pitch on top (local relative to bottom)

			this.bottom.position.copy(this.position);
			this.top.position.set(0, 0.6, 0); // local offset from bottom
		},
		addToScene: function () {
			scene.add(this.bottom); // Only need to add bottom now
		}
	};

	return turret;
}
async function addTurretToPlayer(playerId) {
	if (!arsenals[playerId]) arsenals[playerId] = [];

	const turret = await makeTurret();
	turret.loyalty = playerId;
	turret.addToScene();
	arsenals[playerId].push(turret);

	// Broadcast to others if host
	if (isHost) {
		connections.forEach(c => {
			if (c.open) c.send({
				type: "addTurret",
				playerId: playerId
			});
		});
	}
	// Request from host if client and adding turret to self
	else if (playerId === myID && conn?.open) {
		conn.send({
			type: "requestTurret"
		});
	}
}
function spawnBullet(position, directionVector, id = null, firedId = null) {
	const geo = new THREE.SphereGeometry(0.1, 16, 16);
	const mat = new THREE.MeshBasicMaterial( { color: 0xFFA500 } );
	const mesh = new THREE.Mesh(geo, mat);
	mesh.position.copy(position);
	scene.add(mesh);
	const bullet = {
		id: id || `${myID}_${Date.now()}`,
		firedId: firedId || myID,
		direction: directionVector,
		mesh: mesh,
		testHit: function () {
			raycaster.set(this.mesh.position, this.direction);
			const nearestHit = raycaster.intersectObjects(scene.children, true)[0];
			if (nearestHit) {
				if (nearestHit.distance <= 2) return [true, nearestHit.object];
			}
			return [false];
		},
		move: function () {
			if (this.testHit()[0]) {
				scene.remove(this.mesh);
				this.mesh.geometry?.dispose();
				this.mesh.material?.dispose();
				bullets = bullets.filter(item => item !== this);
			} else {
				this.mesh.position.add(this.direction.clone().multiplyScalar(2 + random(0, 0.5)));
			}
		}
	}
	return bullet;
}
function getHitId(bullet) {
	const bulletHit = bullet.testHit();
	if (bulletHit[0]) {
		const obj = bulletHit[1];
		for (const id in playerCubes) {
			const vehicle = playerCubes[id];
			if (vehicle === obj || vehicle.children.includes(obj)) {
				return id;
			}
			let found = false;
			vehicle.traverse(object => {
				if (object === obj) found = true;
			});
			if (found) return id;
		}
		for (const id in arsenals) {
			for (const turret of arsenals[id]) {
				let found = false;
				turret.bottom.traverse(o => {
					if (o === obj) found = true;
				});
				turret.top.traverse(o => {
					if (o === obj) found = true;
				});
				if (found) return id;
			}
		}
	}
}
function setHealth(percent) {
	const healthBar = document.getElementById('health-bar');
	healthBar.style.width = percent + '%';
}
function makeVehicle() {
	return new Promise((resolve, reject) => {
		const loader = new GLTFLoader();
		loader.load(
			'roller.glb',
			(gltf) => {
				const vehicle = gltf.scene;
				vehicle.scale.set(1, 1, 1);
				resolve(vehicle);
			},
			undefined,
			(error) => {
				reject(error)
			}
		);
	});
}
function make3DCrosshair(radius = 0.5, lineLength = 0.2) {
	const crosshairGroup = new THREE.Group();

	// Create the ring (torus or circle)
	const ringGeometry = new THREE.RingGeometry(radius - 0.02, radius + 0.02, 32);
	const ringMaterial = new THREE.MeshBasicMaterial({
		color: 0xff0000,
		side: THREE.DoubleSide
	});
	const ring = new THREE.Mesh(ringGeometry, ringMaterial);
	crosshairGroup.add(ring);

	// Function to create line from (0,0) to (x,y)
	const createLine = (x1, y1, x2, y2) => {
		const points = [
			new THREE.Vector3(x1, y1, 0),
			new THREE.Vector3(x2, y2, 0),
		];
		const geometry = new THREE.BufferGeometry().setFromPoints(points);
		const material = new THREE.LineBasicMaterial({ color: 0xff0000 });
		return new THREE.Line(geometry, material);
	};

	// Add up/down/left/right lines
	crosshairGroup.add(createLine(0, radius, 0, radius + lineLength)); // Up
	crosshairGroup.add(createLine(0, -radius, 0, -radius - lineLength)); // Down
	crosshairGroup.add(createLine(-radius, 0, -radius - lineLength, 0)); // Left
	crosshairGroup.add(createLine(radius, 0, radius + lineLength, 0)); // Right

	return crosshairGroup;
}
async function init3d() {
	scene = new THREE.Scene();
	scene.background = new THREE.Color(0x87ceeb);
	camera = new THREE.PerspectiveCamera(75, window.innerWidth/window.innerHeight, 0.1, 1000);
	crosshair = make3DCrosshair(0.25);
	crosshair.scale.set(0.5, 0.5, 0.5);
	crosshair.position.set(10, 10, 10);
	scene.add(crosshair);
	renderer = new THREE.WebGLRenderer();
	renderer.setSize(window.innerWidth, window.innerHeight);
	document.body.appendChild(renderer.domElement);
	const light = new THREE.DirectionalLight(0xffffff, 1);
	light.position.set(10, 10, 10);
	scene.add(light);
	const ambientLight = new THREE.AmbientLight(0x404040, 10);
	scene.add(ambientLight);
	const geopl = new THREE.PlaneGeometry(100000, 100000);
	const mat = new THREE.MeshStandardMaterial({
		color: 0x228B22,
		metalness: 0.2,
		roughness: 0.8
	});
	ground = new THREE.Mesh(geopl, mat);
	ground.rotation.x = -Math.PI / 2
	ground.position.y = -1.7
	scene.add(ground);
	for (let i = 0; i < 150; i++) {
		const treex = randomInt(-250, 250);
		const treey = randomInt(-250, 250);
		const tree = await makeTree(treex, treey);
		scene.add(tree);
	}
	animate();
}
function shortestAngleDelta(a, b) {
	let delta = b - a;
	delta = Math.atan2(Math.sin(delta), Math.cos(delta));
	return delta;
}
function animate() {
	requestAnimationFrame(animate);
	const myCube = playerCubes[myID];
	if (myCube) {
		const turretList = arsenals[myID];
		availableTurrets = Array.isArray(turretList) ? turretList : [];
		for (const id in arsenals) {
			const playerCube = playerCubes[id];
			if (!playerCube) continue;
			const turrets = arsenals[id];
			turrets.forEach(turret => {
					if (id === myID) {
					turret.position.copy(playerCube.position.clone().add(new THREE.Vector3(0, 1, -1).applyQuaternion(playerCube.quaternion)));
					// Local player turret: aim based on crosshair
					const turretdx = crosshairLookTarget.x - turret.position.x;
					const turretdz = crosshairLookTarget.z - turret.position.z;
					turret.rotation.y = Math.atan2(turretdx, turretdz);

					const turretTopPos = new THREE.Vector3();
					turret.top.getWorldPosition(turretTopPos);
					const turretdy = crosshairLookTarget.y - turretTopPos.y;
					const horizontalDist = Math.sqrt(turretdx * turretdx + turretdz * turretdz);
					turret.rotation.x = -Math.atan2(turretdy, horizontalDist);

					// Sync host's local turret to others
					if (isHost) {
					syncedTurrets[myID] = {
						position: turret.position.toArray(),
						rotation: { x: turret.rotation.x, y: turret.rotation.y }
						};
					}
				}
	
				turret.updateSystem(); // ✅ Always update visuals
			});
		}
		if (mouseDown) {
			availableTurrets.forEach( turret => {
				if (Date.now() >= turret.cooldown + turret.last) {
					const off = new THREE.Vector3(turret.off, 0, 0.5).applyQuaternion(turret.top.getWorldQuaternion(new THREE.Quaternion()));
					const position = turret.position.clone().add(new THREE.Vector3(0, 0.6, 0).add(off));
					const direction = turret.top.getWorldDirection(new THREE.Vector3());
					const bulletId = `${myID}_${Date.now()}`;
					
					const bullet = spawnBullet(position, direction, bulletId, myID);
					turret.last = Date.now();
					turret.off *= -1;
					bullets.push(bullet);
					
					seenBulletIds.add(bulletId);
					if (!isHost && conn?.open) {
						conn.send({
							type: "fire",
							id: bulletId,
							position: position.toArray(),
							direction: direction.toArray()
						});
					}
					if (isHost) {
						connections.forEach(c => {
							if (c.open) c.send({
								type: "bulletFired",
								id: bulletId,
								playerId: myID,
								position: position.toArray(),
								direction: direction.toArray()
							});
						});
					}
				}
			});
		}
		bullets.forEach(bullet => {
			const hitId = getHitId(bullet);
			if (isHost) {
				if (hitId) {
					const firedId = bullet.firedId;
					if (players[hitId].hp > 0) {
						players[firedId].coins += 10;
					}
					players[hitId].hp = Math.max(players[hitId].hp - 5, 0);
				}
			}
			
			bullet.move();
			if (camera.position.distanceTo(bullet.mesh.position) > 500) {
				scene.remove(bullet.mesh);
				bullet.mesh.geometry?.dispose();
				bullet.mesh.material?.dispose();
				bullets = bullets.filter(item => item !== bullet);
			}
		});
		for (const id in hpbars) {
			const hpBar = hpbars[id];
			hpBar.lookAt(camera.position);
			const hp = players[id].hp / 100;
			hpBar.front.scale.set(hp, 1, 1);
			hpBar.front.position.set(-0.5 + hp / 2, 0, 0);
			hpBar.scale.set(2, 2, 2);
		} 
		setHealth(players[myID].hp);
		document.getElementById('coin-count').textContent = players[myID].coins;
		document.getElementById('loading').style.display = 'none';
		const zoomdist = camera.position.distanceTo(lookTarget);
		const move = new THREE.Vector3(0, 0, mySpeed);
		move.applyQuaternion(myCube.quaternion);
		myCube.position.add(move);
		if (isHost) {
			players[myID].x = myCube.position.x;
			players[myID].z = myCube.position.z;
			players[myID].angle = myCube.rotation.y;
		}
		// Update camera orientation
		// Update camera orientation
		if (mouseMoved) {
			const carToCamDir = new THREE.Vector3().subVectors(camera.position, myCube.position).normalize();
			raycaster.set(myCube.position, carToCamDir);
			const hitGround = raycaster.intersectObject(ground, true);
			camEuler.y += dx / 300;
			if (hitGround.length === 0 || dy > 0) {
				camEuler.x += dy / 300;
			}
			// Clamp pitch to prevent flipping
			const pitchLimit = Math.PI / 2 - 0.1;
			camEuler.x = Math.max(-pitchLimit, Math.min(pitchLimit, camEuler.x));
		} else {
			const distancex = lookTarget.x - myCube.position.x;
			const distancez = lookTarget.z - myCube.position.z;
			const angle = Math.atan2(distancex, distancez);
			camEuler.y = angle
		}
		const quaternion = new THREE.Quaternion().setFromEuler(camEuler)
		// Camera offset behind and slightly above the player
		const camOffset = new THREE.Vector3(0, 4, -8 + zoom).applyQuaternion(quaternion);
		camera.position.copy(myCube.position.clone().add(camOffset));
		// Calculate forward direction
		// Calculate forward direction
		const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion);
		const rayOrigin = camera.position.clone();
		const rayDirection = forward.clone().normalize();
		const lerpFactor = 0.05;
		crosshairEuler.x += shortestAngleDelta(crosshairEuler.x, camEuler.x) * lerpFactor;
		crosshairEuler.y += shortestAngleDelta(crosshairEuler.y, camEuler.y) * lerpFactor;
		const crosshairQuat = new THREE.Quaternion().setFromEuler(crosshairEuler);
		const CrossOff = new THREE.Vector3(0, 4, 2 + zoom).applyQuaternion(crosshairQuat);
		crosshair.position.copy(myCube.position.clone().add(CrossOff));
		crosshair.lookAt(camera.position);
		const crosshairForward = new THREE.Vector3(0, 0, 1).applyQuaternion(crosshairQuat);
		crosshairForward.normalize()
		raycaster.set(crosshair.position.clone(), crosshairForward);
		const CrosshairExclude = new Set();
		myCube.traverse(obj => CrosshairExclude.add(obj));
		CrosshairExclude.add(crosshair);
		const CrosshairHitList = raycaster.intersectObjects(
			scene.children.filter(obj => !CrosshairExclude.has(obj)),
			true
		);
		if (CrosshairHitList.length > 0) {
			crosshairLookTarget.copy(CrosshairHitList[0].point);
		} else {
			crosshairLookTarget.copy(crosshair.position.clone().add(crosshairForward.multiplyScalar(100)));
		}
		if (mouseMoved) {
			raycaster.set(rayOrigin, rayDirection);
			const excludeMyCube = new Set();
			myCube.traverse(obj => excludeMyCube.add(obj));
			excludeMyCube.add(crosshair);
			const hitList = raycaster.intersectObjects(
				scene.children.filter(obj => !excludeMyCube.has(obj)),
				true
			);
			if (hitList.length > 0) {
				lookTarget.copy(hitList[0].point);
			} else {
				lookTarget.copy(rayOrigin.clone().add(rayDirection.multiplyScalar(100)));
			}
			mouseMoved = false;
		}
		camera.lookAt(lookTarget);
		// Reset mouse deltas
		dx = 0;
		dy = 0;
	} else {
		document.getElementById('loading').style.display = 'none';
	}
	renderer.render(scene, camera);
}
function startGame() {
  peer = new Peer();

  peer.on('open', (id) => {
	myID = id;
    tryJoinAsClient(id);
  });

  peer.on('error', (err) => {});
  init3d();
}
function tryJoinAsClient(myId) {
  const tryConn = peer.connect("host");

  tryConn.on("open", () => {
    conn = tryConn;
    setupClientNetworking();
  });

  tryConn.on("error", () => {
    becomeHost(myId);
  });

  setTimeout(() => {
    if (!conn || !conn.open) {
      becomeHost(myId);
    }
  }, 2000);
}

function becomeHost(myId) {
  isHost = true;
  peer = new Peer("host");

  peer.on("open", async () => {
    players[myId] = createInitialPlayer();
    await updateWorld(players);
    console.log("My cube is:", playerCubes[myId]);
  });

  peer.on("connection", (clientConn) => {
    connections.push(clientConn);
    players[clientConn.peer] = createInitialPlayer();

    clientConn.on("data", (data) => {
		if (data.type === "fire") {
			const bulletId = data.id;
			if (seenBulletIds.has(bulletId)) return;
			seenBulletIds.add(bulletId);
			const pos = new THREE.Vector3().fromArray(data.position);
			const dir = new THREE.Vector3().fromArray(data.direction);
			const bullet = spawnBullet(pos, dir, bulletId, clientConn.peer);
			bullets.push(bullet)
			const fireMsg = {
				type: "bulletFired",
				id: bulletId,
				playerId: clientConn.peer,
				position: data.position,
				direction: data.direction
			};
			connections.forEach(c => {
				if (c.open) c.send(fireMsg);
			});
			return;
		}
		if (data.type === "requestTurret") {
			const requesterId = clientConn.peer;
			addTurretToPlayer(requesterId); // Host will add and broadcast
		}
		if (players[clientConn.peer]) {
			players[clientConn.peer] = {
				...players[clientConn.peer],
				...data
			};
			if (data.turrets && Array.isArray(data.turrets)) {
				const turretList = arsenals[clientConn.peer] || [];
				data.turrets.forEach((turretData, i) => {
					const turret = turretList[i];
					if (!turret) return;
					turret.rotation.x = turretData.turretRotation.x;
					turret.rotation.y = turretData.turretRotation.y;
					if (turretData.turretPosition) {
						const target = new THREE.Vector3().fromArray(turretData.turretPosition);
						turret.position.lerp(target, 0.1);
					}
					turret.updateSystem();
				});
			}
		}
    });

    clientConn.on("close", () => {
      delete players[clientConn.peer];
    });
  });

  setInterval(async () => {
    const state = {
      type: "state",
      players,
      turrets: Object.fromEntries(
		Object.entries(arsenals).map(([id, turretList]) => [id, 
			turretList.map(turret => ({
				position: turret.position.toArray(),
				rotation: { x: turret.rotation.x, y: turret.rotation.y }
			}))
		])
	)
      // GLOBAL SHARED FIELDS (optional)
      // gameTime: Date.now() - startTime,
      // powerups: globalPowerups
    };
    connections.forEach((c) => {
      if (c.open) c.send(state);
    });
    await updateWorld(players);
  }, 50);
}
function setupClientNetworking() {
	setInterval(() => {
		const myCube = playerCubes[myID];
		const myTurrets = arsenals[myID];
		if (!myCube || !myTurrets) return;

		const myData = {
			x: myCube.position.x,
			z: myCube.position.z,
			angle: myCube.rotation.y,
			turrets: myTurrets.map(myTurret => ({
				turretRotation: {
					x: myTurret.rotation.x,
					y: myTurret.rotation.y
				},
				turretPosition: myTurret.position.toArray()
			}))
			// SEND NEW FIELDS TO HOST
			// isFiring: Math.random() > 0.9,         
			// Example: randomly fire ⬆️ 
		};

		conn.send(myData);
	}, 50);

  conn.on("data", (data) => {
    if (data.type === "state") {
	  Object.assign(players, data.players);
      updateWorld(data.players);
		if (data.turrets) {
			for (const id in data.turrets) {
				if (id === myID) continue;

				const turretsData = data.turrets[id];
				const turretList = arsenals[id] || [];
				turretsData.forEach((turretData, i) => {
					const turret = turretList[i];
					if (!turret) return;
					// LERP position
					const targetPos = new THREE.Vector3().fromArray(turretData.position);
					turret.position.lerp(targetPos, 0.1); // tweak the factor as needed

					// LERP yaw (rotation.y on bottom)
					const currentYaw = turret.rotation.y;
					const targetYaw = turretData.rotation.y;
					const yawDelta = shortestAngleDelta(currentYaw, targetYaw);
					turret.rotation.y = currentYaw + yawDelta * 0.1;

					// LERP pitch (rotation.x on top)
					const currentPitch = turret.rotation.x;
					const targetPitch = turretData.rotation.x;
					const pitchDelta = shortestAngleDelta(currentPitch, targetPitch);
					turret.rotation.x = currentPitch + pitchDelta * 0.1;

					turret.updateSystem();
				});
			}
		}
      // GLOBAL FIELDS (optional)
      // e.g. show timer: console.log("Time:", data.gameTime);
	}
	if (data.type === "addTurret") {
		const id = data.playerId;
		if (!arsenals[id]) arsenals[id] = [];
		makeTurret().then(turret => {
			turret.loyalty = id;
			turret.addToScene();
			arsenals[id].push(turret);
		});
	}
	if (data.type === "bulletFired") {
		if (seenBulletIds.has(data.id)) return;
		seenBulletIds.add(data.id);
		const pos = new THREE.Vector3().fromArray(data.position);
		const dir = new THREE.Vector3().fromArray(data.direction);
		const bullet = spawnBullet(pos, dir, data.id, data.playerId);
		bullets.push(bullet);
    }
  });
}

function createInitialPlayer() {
  return {
    x: Math.random() * 20,
    z: Math.random() * 20,
    angle: 0,
    hp: 100,
	coins: 0
    // INITIAL STATE FOR NEW FIELDS
    // weapon: "cannon",
    // isFiring: false,
    // score: 0
  };
}
//add stuff here
document.addEventListener('keydown', event => {
	if (event.key === 'w') {
		if (mySpeed < 0.125) {
			mySpeed += 0.05
		}
	} else if (event.key === 's') {
		if (mySpeed > -0.1) {
			mySpeed -= 0.05
		}
	} else if (event.key === 'a') {
		playerCubes[myID].rotation.y += 0.01
	} else if (event.key === 'd') {
		playerCubes[myID].rotation.y -= 0.01
	} else if (event.key === 'q') {
		renderer.domElement.requestPointerLock();
		document.getElementById('qcheck').style.display = 'none';
	}
});
//pointer lock

document.addEventListener('pointerlockchange', () => {
	if (document.pointerLockElement === renderer.domElement) {
		console.log("pointer locked")
	} else {
		console.log("pointer unlocked")
	}
});
document.addEventListener('mousemove', (event) => {
	if (document.pointerLockElement === renderer.domElement) {
		dx = event.movementX;
		dy = event.movementY;
		mouseMoved = true;
	}
});
document.addEventListener('mousedown', (event) => {
	if (event.button === 0) {
		mouseDown = true;
	}
});
document.addEventListener('mouseup', (event) => {
	if (event.button === 0) {
		mouseDown = false;
	}
});
document.addEventListener('wheel', (event) => {
	zoom -= event.deltaY / 200;
	zoom = Math.max(0, Math.min(20, zoom)); // clamp between 0 and 20
});
//end stuff
const loadingPlayers = new Set();

async function updateWorld(playersState) {
  for (const id in playersState) {
	const p = playersState[id];
    if (!playerCubes[id] && !loadingPlayers.has(id)) {
      loadingPlayers.add(id);
      const cube = await makeVehicle();
      scene.add(cube);
      playerCubes[id] = cube;
      if (id !== myID) {
		  const hpBar = new THREE.Object3D();
		  const hpgeo = new THREE.BoxGeometry(1, 0.25, 0.1);
		const frontmat = new THREE.MeshBasicMaterial( {color: 0x32CD32} );
		const hpfront = new THREE.Mesh(hpgeo, frontmat);
		const backmat = new  THREE.MeshBasicMaterial( {color: 0x000000} );
		const hpback = new THREE.Mesh(hpgeo, backmat);
		hpBar.add(hpfront);
		hpBar.add(hpback);
		hpback.position.set(0, 0, -0.1);
		cube.add(hpBar);
		hpBar.position.set(0, 5, 0);
		hpBar.front = hpfront;
		hpbars[id] = hpBar;
	} else {
		cube.position.set(randomInt(-50, 50), 0, randomInt(-50, 50));
	}
      loadingPlayers.delete(id);
    }
    if (!arsenals[id] && playerCubes[id] && !loadingTurrets.has(id)) {
		loadingTurrets.add(id);
		const turret = await makeTurret();
		turret.loyalty = id;
		turret.addToScene();
		arsenals[id] = [turret];
		loadingTurrets.delete(id);
	}
    const cube = playerCubes[id];

    if (id === myID) {
		continue
    } else {
      // Interpolate for others
      cube.position.lerp(new THREE.Vector3(p.x, 0, p.z), 0.1);
      const turret = arsenals[id];
      const currentAngle = cube.rotation.y;
      const targetAngle = p.angle;
      const angleDiff = targetAngle - currentAngle;
      cube.rotation.y = currentAngle + angleDiff * 0.1;
    }
  }

  for (const id in playerCubes) {
    if (!playersState[id] && id !== myID) {
      scene.remove(playerCubes[id]);
      delete playerCubes[id];
      delete hpbars[id];
      const turretList = arsenals[id];
		if (turretList) {
			turretList.forEach(turret => {
				scene.remove(turret.bottom);
				turret.bottom.traverse(obj => {
					if (obj.geometry) obj.geometry.dispose();
					if (obj.material) obj.material.dispose();
				});
			});
			delete arsenals[id];
		}
    }
  }

}
startGame();
setInterval(() => {
	if (seenBulletIds.size > 1000) seenBulletIds.clear();
}, 60000);

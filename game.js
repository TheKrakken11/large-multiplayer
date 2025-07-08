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
let ymod = 0;
const players = {};
let ground;
const connections = [];
let scene, camera, renderer;
let camEuler = new THREE.Euler(0, 0, 0, 'YXZ');
const raycaster = new THREE.Raycaster();
let lookTarget = new THREE.Vector3();
let cameraLocked = false;
const playerCubes = {};
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
function init3d() {
	scene = new THREE.Scene();
	scene.background = new THREE.Color(0x87ceeb);
	camera = new THREE.PerspectiveCamera(75, window.innerWidth/window.innerHeight, 0.1, 1000);
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
	animate();
}
function animate() {
	requestAnimationFrame(animate);
	const myCube = playerCubes[myID];
	if (myCube) {
		document.getElementById('loading').style.display = 'none';
		const move = new THREE.Vector3(0, 0, mySpeed);
		move.applyQuaternion(myCube.quaternion);
		myCube.position.add(move);
		if (isHost) {
			players[myID].x = myCube.position.x;
			players[myID].z = myCube.position.z;
			players[myID].angle = myCube.rotation.y;
		}
		// Update camera orientation only if mouse moved
                camEuler.y += dx / 300;
		ymod -= dy / 100;
		const quaternion = new THREE.Quaternion();
		quaternion.setFromEuler(camEuler);
		// Camera offset from player (position behind and above)
		const camOffset = new THREE.Vector3(0, 4, -8).applyQuaternion(quaternion);
		camera.position.copy(myCube.position.clone().add(camOffset));
		// If mouse moved, update the lookTarget
		if (dx !== 0 || dy !== 0 || !cameraLocked) {
			const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(quaternion);
			lookTarget.copy(camera.position).add(forward.multiplyScalar(100)); // Look far ahead
			lookTarget.y = myCube.position.y + 4 + ymod;
			cameraLocked = true;
		}
		// Always look at last look target
		camera.lookAt(lookTarget);
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
      if (players[clientConn.peer]) {
        players[clientConn.peer] = {
          ...players[clientConn.peer],
          ...data
          // MERGE CLIENT FIELDS — already works as-is
          // e.g. isFiring, weapon, score are merged here
        };
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
		if (!myCube) return;

		const myData = {
			x: myCube.position.x,
			z: myCube.position.z,
			angle: myCube.rotation.y,
			// SEND NEW FIELDS TO HOST
			// isFiring: Math.random() > 0.9,         
			// Example: randomly fire ⬆️ 
		};

		conn.send(myData);
	}, 50);

  conn.on("data", (data) => {
    if (data.type === "state") {
      updateWorld(data.players);
      // GLOBAL FIELDS (optional)
      // e.g. show timer: console.log("Time:", data.gameTime);
    }
  });
}

function createInitialPlayer() {
  return {
    x: Math.random() * 20,
    z: Math.random() * 20,
    angle: 0,
    hp: 100,
    // INITIAL STATE FOR NEW FIELDS
    // weapon: "cannon",
    // isFiring: false,
    // score: 0
  };
}
//add stuff here
document.addEventListener('keydown', event => {
	if (event.key === 'w') {
		if (mySpeed < 0.5) {
			mySpeed += 0.05
		}
	} else if (event.key === 's') {
		if (mySpeed > -0.25) {
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
	}
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
      loadingPlayers.delete(id);
    }
    const cube = playerCubes[id];

    if (id === myID) {
		continue
    } else {
      // Interpolate for others
      cube.position.lerp(new THREE.Vector3(p.x, 0, p.z), 0.1);
      const currentAngle = cube.rotation.y;
      const targetAngle = p.angle;
      const angleDiff = targetAngle - currentAngle;
      cube.rotation.y = currentAngle + angleDiff * 0.1;
    }
  }

  for (const id in playerCubes) {
    if (!playersState[id]) {
      scene.remove(playerCubes[id]);
      delete playerCubes[id];
    }
  }
}
startGame()

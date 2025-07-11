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
await new Promise((res, rej) => {
  const s = document.createElement('script');
  s.src = 'https://unpkg.com/peerjs@1.4.7/dist/peerjs.min.js';
  s.onload = res; s.onerror = rej;
  document.body.appendChild(s);
});

let peer, conn, isHost = false;
let myID = null;
const players = {};
const remoteBullets = {};
const bulletSpawnQueue = [];

let scene, camera, renderer;
let ground;
let camEuler = new THREE.Euler(0,0,0,'YXZ');
let crosshairEuler = new THREE.Euler(0,0,0,'YXZ');
const raycaster = new THREE.Raycaster();
let lookTarget = new THREE.Vector3();
let crosshairLookTarget = new THREE.Vector3();
let zoom = 0, mySpeed = 0, mouseDown = false, mouseMoved = false;
let dx=0, dy=0;
const playerCubes = {};
const myTurretBySelf = null;

function random(min,max){ return Math.random()*(max-min)+min; }
function randomInt(min,max){ return Math.floor(random(min,max)); }
function shortestAngleDelta(a,b){
  const d=b-a;
  return Math.atan2(Math.sin(d), Math.cos(d));
}
async function loadIt(url){
  const loader = new GLTFLoader();
  const gltf = await new Promise((res,rej)=>
    loader.load(url, r=>res(r),undefined,err=>rej(err))
  );
  return gltf.scene;
}
async function makeTurret(){
  const top = await loadIt('turret_top.glb');
  const bottom = await loadIt('turret_bottom.glb');
  bottom.add(top);
  const turret = {
    top, bottom,
    off: 0.4,
    cooldown: 500,
    last: 0,
    rotation:{x:0,y:0},
    position: new THREE.Vector3(),
    updateSystem(){
      this.bottom.rotation.y = this.rotation.y;
      this.top.rotation.x = this.rotation.x;
      this.bottom.position.copy(this.position);
      this.top.position.set(0,0.6,0);
    },
    addToScene(){ scene.add(this.bottom); }
  };
  return turret;
}
function spawnBullet(pos, dir){
  const geo=new THREE.SphereGeometry(0.1,16,16);
  const mat=new THREE.MeshBasicMaterial({color:0xffa500});
  const mesh=new THREE.Mesh(geo,mat);
  mesh.position.copy(pos);
  scene.add(mesh);
  const bulletAz={ direction: dir.clone(), mesh };
  bulletSpawnQueue.push({
    id: `${myID}_${Date.now()}_${Math.random()}`,
    x: pos.x, y: pos.y, z: pos.z,
    dx: dir.x, dy: dir.y, dz: dir.z
  });
  return bulletAz;
}
function make3DCrosshair(r, ll){
  const g=new THREE.Group();
  const ring=new THREE.Mesh(
    new THREE.RingGeometry(r-0.02, r+0.02, 32),
    new THREE.MeshBasicMaterial({color:0xff0000, side: THREE.DoubleSide})
  );
  g.add(ring);
  const makeLine=(x1,y1,x2,y2)=>{
    const pts=[new THREE.Vector3(x1,y1,0), new THREE.Vector3(x2,y2,0)];
    const geo=new THREE.BufferGeometry().setFromPoints(pts);
    return new THREE.Line(geo, new THREE.LineBasicMaterial({color:0xff0000}));
  };
  g.add(makeLine(0,r,0,r+ll));
  g.add(makeLine(0,-r,0,-r-ll));
  g.add(makeLine(-r,0,-r-ll,0));
  g.add(makeLine(r,0,r+ll,0));
  return g;
}

let myTurret, bullets = [];

async function init3d(){
  scene=new THREE.Scene();
  scene.background=new THREE.Color(0x87ceeb);
  camera=new THREE.PerspectiveCamera(75, window.innerWidth/window.innerHeight, 0.1,1000);
  const cross = make3DCrosshair(0.25,0.2);
  cross.scale.set(0.5,0.5,0.5);
  scene.add(cross);
  renderer=new THREE.WebGLRenderer();
  renderer.setSize(window.innerWidth,window.innerHeight);
  document.body.appendChild(renderer.domElement);
  scene.add(new THREE.DirectionalLight(0xffffff,1));
  scene.add(new THREE.AmbientLight(0x404040,10));
  ground=new THREE.Mesh(new THREE.PlaneGeometry(100000,100000),
                       new THREE.MeshStandardMaterial({color:0x228B22,metalness:0.2,roughness:0.8}));
  ground.rotation.x=-Math.PI/2; ground.position.y=-1.7;
  scene.add(ground);
  for(let i=0;i<150;i++){
    const t=await loadIt('Tree.glb');
    t.position.set(randomInt(-250,250),0,randomInt(-250,250));
    t.rotation.y=random(0,Math.PI*2);
    const s=random(0.2,0.4);
    t.scale.set(s,s,s);
    t.position.y=(7-1.2)*s;
    scene.add(t);
  }
  myTurret=await makeTurret();
  myTurret.addToScene();
  bullets = [];
  animate();
}

function animate(){
  requestAnimationFrame(animate);
  const me = playerCubes[myID];
  if(me){
    // turret aiming using crosshairLookTarget
    const tx = crosshairLookTarget.x - me.position.x;
    const tz = crosshairLookTarget.z - me.position.z;
    myTurret.rotation.y = Math.atan2(tx, tz);
    const twPos=new THREE.Vector3();
    myTurret.top.getWorldPosition(twPos);
    const ty = crosshairLookTarget.y - twPos.y;
    const horiz=Math.sqrt(tx*tx + tz*tz);
    myTurret.rotation.x = -Math.atan2(ty, horiz);
    myTurret.position.copy(me.position.clone().add(new THREE.Vector3(0,1,-1)));
    myTurret.updateSystem();

    if(mouseDown && Date.now() >= myTurret.last + myTurret.cooldown){
      const off = new THREE.Vector3(myTurret.off,0,0)
                    .applyQuaternion(myTurret.bottom.quaternion);
      const b = spawnBullet(myTurret.position.clone().add(new THREE.Vector3(0,0.6,0).add(off)),
                            myTurret.top.getWorldDirection(new THREE.Vector3()));
      bullets.push(b);
      myTurret.last = Date.now();
      myTurret.off *= -1;
    }

    bullets.forEach((b,i)=>{
      b.mesh.position.add(b.direction.clone().multiplyScalar(2));
      if(camera.position.distanceTo(b.mesh.position)>100){
        scene.remove(b.mesh);
        b.mesh.geometry.dispose();
        b.mesh.material.dispose();
        bullets.splice(i,1);
      }
    });
  }

  // move remote bullets
  for(const id in remoteBullets){
    const rb = remoteBullets[id];
    rb.mesh.position.add(rb.direction.clone().multiplyScalar(2));
    if(camera.position.distanceTo(rb.mesh.position)>100){
      scene.remove(rb.mesh);
      delete remoteBullets[id];
    }
  }

  // camera & crosshair logic...
  // (unchanged from your current code)

  renderer.render(scene,camera);
}

function startGame(){
  peer = new Peer();
  peer.on('open', id => { myID = id; tryJoinAsClient(id); });
  peer.on('error', err => {});
  init3d();
}

function tryJoinAsClient(id){
  const c = peer.connect('host');
  c.on('open', () => { conn = c; setupClientNetworking(); });
  c.on('error', () => { becomeHost(id); });
  setTimeout(() => { if(!conn || !conn.open) becomeHost(id); },2000);
}

function becomeHost(id){
  isHost = true;
  peer = new Peer('host');
  peer.on('open', () => {
    players[id] = createInitialPlayer();
    updateWorld(players);
  });
  peer.on('connection', cl => {
    players[cl.peer] = createInitialPlayer();
    cl.on('data', data => {
      players[cl.peer] = {...players[cl.peer], ...data};
      if(data.bullets){
        data.bullets.forEach(b=>{
          if(!remoteBullets[b.id]){
            const geo=new THREE.SphereGeometry(0.1,8,8);
            const mat=new THREE.MeshBasicMaterial({color:0x00ff00});
            const mesh=new THREE.Mesh(geo,mat);
            mesh.position.set(b.x,b.y,b.z);
            scene.add(mesh);
            remoteBullets[b.id]={mesh,direction:new THREE.Vector3(b.dx,b.dy,b.dz)};
          }
        });
      }
    });
    cl.on('close',()=>delete players[cl.peer]);
  });

  setInterval(()=>{
    const state = {type:'state', players};
    connections.forEach(c => c.open && c.send(state));
    updateWorld(players);
  },50);
}

function setupClientNetworking(){
  connections.push(conn);
  setInterval(()=>{
    const myCube = playerCubes[myID];
    if(!myCube) return;
    const data = {
      x: myCube.position.x,
      z: myCube.position.z,
      angle: myCube.rotation.y,
      bullets: bulletSpawnQueue.slice()
    };
    conn.send(data);
    bulletSpawnQueue.length = 0;
  },50);

  conn.on('data', d => {
    if(d.type==='state'){
      updateWorld(d.players);
    }
  });
}

function createInitialPlayer(){
  return {x:Math.random()*20, z:Math.random()*20, angle:0, bullets:{}};
}

async function updateWorld(playersState){
  for(const id in playersState){
    if(!playerCubes[id]){
      const cube=await loadIt('roller.glb');
      scene.add(cube);
      playerCubes[id]=cube;
    }
    const p = playersState[id];
    const cube = playerCubes[id];
    if(id !== myID){
      cube.position.lerp(new THREE.Vector3(p.x, 0, p.z), 0.1);
      cube.rotation.y += shortestAngleDelta(cube.rotation.y, p.angle)*0.1;
    }
  }
  for(const id in playerCubes){
    if(!playersState[id]){
      scene.remove(playerCubes[id]);
      delete playerCubes[id];
    }
  }
}

document.addEventListener('keydown', e=>{
  if(e.key==='w') mySpeed = Math.min(mySpeed+0.05, 0.125);
  if(e.key==='s') mySpeed = Math.max(mySpeed-0.05, -0.1);
});
document.addEventListener('mousemove', e=>{
  if(document.pointerLockElement === renderer.domElement){
    dx = e.movementX; dy = e.movementY;
    mouseMoved = true;
  }
});
document.addEventListener('mousedown', e=>{ if(e.button===0) mouseDown = true; });
document.addEventListener('mouseup', e=>{ if(e.button===0) mouseDown = false; });
document.addEventListener('wheel', e=>{
  zoom = Math.max(0, Math.min(20, zoom - e.deltaY/200));
});
document.addEventListener('pointerlockchange', ()=>{});
startGame();

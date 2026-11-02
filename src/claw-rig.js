/**
 * ClawRig — Complete 3d-spring-studio claw system fitted to the exact interior geometry
 * of cabinet.min.glb:
 * - Hides legacy static Blender rails (RailSideL) inside cabinet.min.glb
 * - Mounts fixed Z-rails flush under the cabinet ceiling side frames (world X = ±0.326,
 *   world Y = 1.50, world Z = -0.40 .. +0.31)
 * - Dual visible cables: taut central winch cord (red braided + steel core) attached to
 *   the claw top eyelet + beside it the coiled elastic J-curve telephone cord
 * - Real floor-impact bounce physics: gravity-accelerated drop that impacts the plush pit
 *   floor and rebounds 2-3 times with spring wave + tilt before grabbing
 */
import * as THREE from 'three';
import { mergeGeometries } from '../vendor/addons/utils/BufferGeometryUtils.js';

const RIG_SCALE = 0.22;
const RIG_FLOOR_Y = -1.20;         // studio-space pit floor
const WORLD_FLOOR_Y = 0.725;       // measured top surface of cabinet floor (tripo_part_18)
const WORLD_CENTER_X = 0.0;        // exact X center of cabinet glass bay
const WORLD_CENTER_Z = -0.045;     // exact Z center of cabinet glass bay (-0.42 .. +0.33)

// Ceiling & travel geometry in rig-space (1 rig unit = 0.22 world units)
// Roof frame underside is at world Y = 1.53 -> rig Y = 2.46
const RAIL_Y = 2.40;               // world Y = 1.513 (flush with upper red frame)
const BRIDGE_Y = 2.33;
const TROLLEY_Y = 2.20;
const TOP_CARRIAGE_Y = 2.08;
const CLAW_HANG = 0.30;
const CLAW_SCALE = 1.32;

// Longer rope at rest & deeper drop so claw tips firmly hit and bounce on the pit floor
const DROP_MAX = 2.48;
const DROP_REST = 0.48;

const RAIL_X = 1.62;               // world X = ±0.356 (bolted directly against inner red side pillars)
const RAIL_Z_MIN = -1.68;          // world Z = -0.415 (back pillar)
const RAIL_Z_MAX = 1.66;           // world Z = +0.320 (front pillar)
const TRAVEL_X = 1.28;             // trolley X travel
const TRAVEL_Z = 1.32;             // trolley Z travel

// PRIZE OUT glass box in cabinet is at world X: -0.35..-0.08, Z: -0.08..+0.27
// In rig space (centered at 0, -0.045): X ≈ -1.0, Z ≈ +0.62
const CHUTE = { x: -0.98, z: 0.62 };

const LATERAL_OFFSET = 0.13;
const SPRING_COILS = 17;
const SPRING_RADIUS = 0.056;
const SPRING_TUBE = 0.019;
const CORD_TUBE = 0.022;

// --- Rigid-body prize physics constants (rig-space units) ---
const PHYS_G = -9.8;
const PHYS_SUBSTEPS = 4;
const FLOOR_Y = -1.20;                 // pit floor top surface
const WALL_X_MIN = -1.66;              // glass interior bounds
const WALL_X_MAX = 1.72;
const WALL_Z_MIN = -1.72;
const WALL_Z_MAX = 1.68;
const CHUTE_KILL_Y = -2.1;             // below this the prize landed in the bin -> respawn
// PRIZE OUT glass box footprint (matches vidrio_buzon: rig X -1.64..-0.34, Z -0.17..+1.45, topY -0.62)
const CHUTE_BOX = {
  xMin: -1.66, xMax: -0.34,
  zMin: -0.17, zMax: 1.68,
  topY: -0.58,                         // acrylic box rim height in rig space
  holeX: -0.99, holeZ: 1.08, holeR: 0.48
};

const _tmpA = new THREE.Vector3();
const _tmpB = new THREE.Vector3();
const _topAnchor = new THREE.Vector3();
const _clawAnchor = new THREE.Vector3();
const _topCord = new THREE.Vector3();
const _clawCord = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _euler = new THREE.Euler();

// ---------------------------------------------------------------------------
// Floor-Impact + Elastic Cable Rebound + 2D Pendulum + Coiled Cord Wave Physics
// ---------------------------------------------------------------------------
export function stepClawBouncePhysics(
  current, targetDrop, dt, bounciness = 0.74, springStiffness = 52, mass = 1.8,
  trolleyAccX = 0, trolleyAccZ = 0, contact = null
) {
  const safeDt = Math.min(0.04, Math.max(0.001, dt));
  let drop = current.drop;
  let vel = current.dropVelocity;
  let sway = current.swayAngle;
  let swayVel = current.swayVelocity;
  let swayZ = current.swayAngleZ;
  let swayVelZ = current.swayVelocityZ;
  let coilWave = current.coilWave;
  let coilWaveVel = current.coilWaveVel;
  let groundTiltX = current.groundTiltX || 0;
  let groundTiltZ = current.groundTiltZ || 0;
  let supported = current.supported || false;
  let ropeSlack = current.ropeSlack || 0;
  let sagX = current.sagX || 0;
  let sagZ = current.sagZ || 0;
  let didBounce = false;
  let bounceImpact = 0;

  const prevVel = vel;
  const isDroppingToFloor = targetDrop > 1.5;

  if (isDroppingToFloor) {
    // Real arcade claw: dead-weight drop, lands on the pile, winch keeps paying
    // out -> rope goes slack + claw leans & sags sideways. NO harmonic bounce.
    const contactDrop = contact ? contact.drop : targetDrop;
    if (!supported) {
      const gravityAcc = 2.4;
      vel = Math.min(1.45, vel + gravityAcc * safeDt);
      drop += vel * safeDt;

      // Slight helical drift while unwinding
      swayVel += Math.sin(drop * 3.2) * 0.14 * safeDt;
      swayVelZ += Math.cos(drop * 2.8) * 0.11 * safeDt;

      // Dead landing on the pit floor or on top of a plush
      if (drop >= contactDrop && vel > 0) {
        drop = contactDrop;
        bounceImpact = Math.min(1.0, vel * 0.4);
        vel = 0;
        didBounce = true;
        supported = true;
        coilWaveVel += bounceImpact * 1.4;
        groundTiltX = contact ? contact.tiltX : 0;
        groundTiltZ = contact ? contact.tiltZ : 0;
        swayVel += groundTiltX * 1.1;
        swayVelZ += groundTiltZ * 0.9;
      }
    } else {
      // Resting on the pile: rope slack grows, claw leans into the soft side
      vel = 0;
      drop = contactDrop;
      ropeSlack = THREE.MathUtils.damp(
        ropeSlack,
        Math.min(0.17, Math.max(0, targetDrop - contactDrop) * 1.5),
        2.6, safeDt
      );
      const leanX = contact ? contact.tiltX : 0;
      const leanZ = contact ? contact.tiltZ : 0;
      groundTiltX = THREE.MathUtils.damp(groundTiltX, leanX, 2.8, safeDt);
      groundTiltZ = THREE.MathUtils.damp(groundTiltZ, leanZ, 2.8, safeDt);
      sagX = THREE.MathUtils.damp(sagX, leanX * 0.42, 1.7, safeDt);
      sagZ = THREE.MathUtils.damp(sagZ, leanZ * 0.42, 1.7, safeDt);
    }
  } else {
    supported = false;
    ropeSlack = THREE.MathUtils.damp(ropeSlack, 0, 6.5, safeDt);
    sagX = THREE.MathUtils.damp(sagX, 0, 5, safeDt);
    sagZ = THREE.MathUtils.damp(sagZ, 0, 5, safeDt);
    // Slow, steady winch hoisting back up + gentle spring settle at the top
    const displacement = drop - targetDrop;
    if (displacement > 0.12) {
      // Constant slow upward winch speed while hoisting
      const targetHoistVel = -0.82;
      vel = THREE.MathUtils.damp(vel, targetHoistVel, 5.0, safeDt);
      drop += vel * safeDt;
    } else if (Math.abs(displacement) > 0.003 || Math.abs(vel) > 0.006) {
      const k = (springStiffness * 0.45) * (1.15 - bounciness * 0.35);
      const damping = (1.0 - bounciness * 0.65) * 4.8;
      const acc = (-k * displacement - damping * vel) / Math.max(0.2, mass);
      vel += acc * safeDt;
      drop += vel * safeDt;
    } else {
      drop = targetDrop;
      vel = 0;
    }
    groundTiltX = THREE.MathUtils.damp(groundTiltX, 0, 3.5, safeDt);
    groundTiltZ = THREE.MathUtils.damp(groundTiltZ, 0, 3.5, safeDt);
  }

  if (drop < 0) { drop = 0; vel = Math.max(0, vel); }

  // Coiled cord internal axial wave oscillator (whip/lag effect)
  const axialJerk = (vel - prevVel) / safeDt;
  const waveAcc = -72 * coilWave - 4.4 * coilWaveVel - axialJerk * 0.042;
  coilWaveVel += waveAcc * safeDt;
  coilWave = THREE.MathUtils.clamp(coilWave + coilWaveVel * safeDt, -0.26, 0.26);

  // 2D spherical pendulum coupled to cable length L(t) & trolley acceleration
  const effectiveLength = Math.max(0.38, drop + 0.32);
  const gravity = 9.81;
  const coriolis = THREE.MathUtils.clamp((vel / effectiveLength) * 0.65, -1.5, 1.5);
  const swayDamping = 1.75 + coriolis;

  const swayAccX =
    -(gravity / effectiveLength) * Math.sin(sway) -
    swayDamping * swayVel -
    (trolleyAccX / effectiveLength) * 0.55;
  swayVel += swayAccX * safeDt;
  sway = THREE.MathUtils.clamp(sway + swayVel * safeDt, -0.48, 0.48);

  const swayAccZ =
    -(gravity / effectiveLength) * Math.sin(swayZ) -
    swayDamping * swayVelZ -
    (trolleyAccZ / effectiveLength) * 0.55;
  swayVelZ += swayAccZ * safeDt;
  swayZ = THREE.MathUtils.clamp(swayZ + swayVelZ * safeDt, -0.48, 0.48);

  return {
    next: {
      drop, dropVelocity: vel,
      swayAngle: sway, swayVelocity: swayVel,
      swayAngleZ: swayZ, swayVelocityZ: swayVelZ,
      coilWave, coilWaveVel,
      groundTiltX, groundTiltZ,
      supported, ropeSlack, sagX, sagZ,
      bouncesCount: didBounce ? current.bouncesCount + 1 : current.bouncesCount
    },
    didBounce,
    bounceImpact
  };
}

// Ported: 4-bar linkage kinematics
export function calculateClawProngs(openFactor) {
  const c = THREE.MathUtils.clamp(openFactor, 0, 1);
  return {
    upperAngle: 0.2 + c * 0.65,
    tipAngle: 0.4 + c * 0.45,
    spreadDistance: 0.12 + c * 0.28,
    plungerOffset: -0.13 - c * 0.075,
    fingerPitch: -0.18 + c * 0.72,
    strutAngle: 0.12 + c * 0.26
  };
}

// Taut winch rope connecting trolley drum nozzle -> claw top eyelet (bows slightly on floor bounce)
class TensionCordCurve extends THREE.Curve {
  constructor() {
    super();
    this.top = new THREE.Vector3();
    this.bottom = new THREE.Vector3();
    this.slack = 0;
  }
  getPoint(t, target = new THREE.Vector3()) {
    target.lerpVectors(this.top, this.bottom, t);
    if (this.slack > 0.001) {
      const sag = Math.sin(t * Math.PI);
      target.x += sag * this.slack;
      target.z += Math.sin(t * Math.PI * 2) * this.slack * 0.35;
      target.y -= sag * this.slack * 1.15; // gravity droop — paid-out rope bellies down
    }
    return target;
  }
}

// Coiled elastic telephone cord w/ J-loop, gravity pitch & wave whip
class DynamicClawSpringCurve extends THREE.Curve {
  constructor(top, claw, coils, radius, offset, coilWave = 0, swayX = 0, swayZ = 0) {
    super();
    this.top = top.clone();
    this.claw = claw.clone();
    this.coils = coils;
    this.radius = radius;
    this.offset = offset;
    this.coilWave = coilWave;
    this.swayX = swayX;
    this.swayZ = swayZ;
  }
  getPoint(t, target = new THREE.Vector3()) {
    const spanY = Math.max(0.18, this.top.y - this.claw.y);
    const retractRatio = THREE.MathUtils.clamp(1 - (spanY - 0.25) / 0.85, 0, 1);
    const catenaryBelly = Math.sin(t * Math.PI) * (retractRatio * 0.14);
    const waveShift = Math.sin(t * Math.PI * 2) * this.coilWave * 0.095;
    const effectiveT = THREE.MathUtils.clamp(Math.pow(t, 1.06) + waveShift, 0, 1);

    const y = THREE.MathUtils.lerp(this.top.y, this.claw.y, effectiveT) - catenaryBelly;
    const baseX = THREE.MathUtils.lerp(this.top.x, this.claw.x, t);
    const baseZ = THREE.MathUtils.lerp(this.top.z, this.claw.z, t);

    const endTaper =
      Math.sin(Math.min(1, t / 0.055) * Math.PI * 0.5) *
      Math.sin(Math.min(1, (1 - t) / 0.055) * Math.PI * 0.5);
    const activeRadius = this.radius * endTaper;
    const theta = t * this.coils * Math.PI * 2;

    const midSag = Math.sin(t * Math.PI);
    const bowOutX = -midSag * (this.offset * (0.42 + retractRatio * 0.52)) - midSag * this.swayX * 0.16;
    const bowOutZ = -midSag * this.swayZ * 0.16;

    return target.set(
      baseX + bowOutX + Math.cos(theta) * activeRadius,
      y,
      baseZ + bowOutZ + Math.sin(theta) * activeRadius
    );
  }
}

// ---------------------------------------------------------------------------
// Collapse a static multi-part prize into one mesh per (material, castShadow).
// Merged meshes keep the order of their last part, so the last child's color is unchanged.
function mergeByMaterial(g) {
  const parts = new Map();
  g.children.forEach((c, i) => {
    const k = `${c.material.uuid}|${c.castShadow}`;
    if (!parts.has(k)) parts.set(k, { mat: c.material, cast: c.castShadow, geos: [], last: i });
    c.updateMatrix();
    const e = parts.get(k);
    e.geos.push(c.geometry.clone().applyMatrix4(c.matrix));
    e.last = i;
    c.geometry.dispose();
  });
  g.clear();
  [...parts.values()].sort((a, b) => a.last - b.last).forEach((e) => {
    const m = new THREE.Mesh(mergeGeometries(e.geos), e.mat);
    m.castShadow = e.cast;
    g.add(m);
    e.geos.forEach((x) => x.dispose());
  });
}

const _instMat = new THREE.Matrix4();
const _instScale = new THREE.Vector3();

export class ClawRig {
  constructor(machine, scene) {
    this.machine = machine;
    this.scene = scene;

    // Hide any old static rail / ceiling-stump meshes baked into cabinet.min.glb
    if (machine) {
      machine.traverse((o) => {
        if (
          o.name &&
          (o.name.startsWith('RailSide') ||
            o.name.startsWith('Gantry') ||
            o.name === 'tripo_part_12' ||
            o.name === 'tripo_part_19' ||
            o.name === 'tripo_part_51' ||
            o.name === 'tripo_part_69')
        ) {
          o.visible = false;
        }
      });
    }

    // Rig-space container mapped inside the GLB cabinet's prize cavity
    this.rigGroup = new THREE.Group();
    this.rigGroup.scale.setScalar(RIG_SCALE);
    this.rigGroup.position.set(
      WORLD_CENTER_X,
      WORLD_FLOOR_Y - RIG_FLOOR_Y * RIG_SCALE,
      WORLD_CENTER_Z
    );
    scene.add(this.rigGroup);

    this.t = 0;
    this.phase = 'idle';
    this.phaseTimer = 0;
    this.autoDemo = false;
    this.prizesWon = 0;
    this.lastWonPrize = '';
    this.onPrizeWon = null;
    this.grabbedPrize = null;
    // Verse dealing: every prize is born carrying a verse index into the pool
    // (deck set via setVerseDeck; deals cycle + reshuffle so the machine
    // re-stocks fresh verses as prizes are won and respawn).
    this.verseDeck = null;
    this._deckPos = 0;

    this.targetTX = 0.35;
    this.targetTZ = -0.15;
    this.targetDrop = DROP_REST;
    this.targetOpen = 0.82;

    // Machine grip strength (like the operator setting on a real claw):
    // scales max tangential friction at finger contacts. Higher = holds
    // heavy plushies better; low = prizes slip out between the fingers.
    this.gripStrength = 0.62;
    this._carried = null;

    this.anim = {
      smoothTX: 0.35,
      smoothTZ: -0.15,
      trolleyVelX: 0,
      trolleyVelZ: 0,
      currentDrop: DROP_REST,
      currentOpen: 0.82
    };

    this.phys = {
      drop: DROP_REST,
      dropVelocity: 0,
      swayAngle: 0,
      swayVelocity: 0,
      swayAngleZ: 0,
      swayVelocityZ: 0,
      coilWave: 0,
      coilWaveVel: 0,
      groundTiltX: 0,
      groundTiltZ: 0,
      supported: false,
      ropeSlack: 0,
      sagX: 0,
      sagZ: 0,
      bouncesCount: 0
    };

    this.prizes = [];
    this.prongRigs = [];

    // BMX-wheel-style claw colliders: bell + 3 knuckles + a 4-node contact
    // chain running along each finger's real C-curve (16 colliders total).
    // The chain wraps prizes like a wheel's contact patch when fingers close.
    this._colliders = [{ pos: new THREE.Vector3(), r: 0.17 }];
    for (let i = 0; i < 3; i++) this._colliders.push({ pos: new THREE.Vector3(), r: 0.07 });
    for (let i = 0; i < 12; i++) this._colliders.push({ pos: new THREE.Vector3(), r: 0.06 });
    this._grabCandidate = null;

    this._buildGantry();
    this._buildTrolley();
    this._buildCords();
    this._buildClaw();
    this._buildChuteRamp();
    this._buildPrizes();
  }

  // --- Stainless-steel prize chute hopper & directional metal ramp inside vidrio_buzon ---
  // Seals the floor hole completely and guides dropped spheres forward (+Z) and down (-Y)
  // straight toward the lower-left PRIZE OUT door (tripo_part_33 / tripo_part_20).
  _buildChuteRamp() {
    const g = new THREE.Group();
    this.rigGroup.add(g);

    const steelMat = new THREE.MeshStandardMaterial({
      color: 0xdbe3ee,
      metalness: 0.90,
      roughness: 0.22,
      envMapIntensity: 1.25,
      side: THREE.DoubleSide
    });
    const chromeMat = new THREE.MeshStandardMaterial({
      color: 0xf8fafc,
      metalness: 0.97,
      roughness: 0.08,
      envMapIntensity: 1.4
    });
    const darkHousingMat = new THREE.MeshStandardMaterial({
      color: 0x161b26,
      metalness: 0.72,
      roughness: 0.45,
      side: THREE.DoubleSide
    });
    const throatDarkMat = new THREE.MeshStandardMaterial({
      color: 0x090b10,
      metalness: 0.35,
      roughness: 0.85,
      side: THREE.DoubleSide
    });

    const xMin = -1.61, xMax = -0.37;
    const zMin = -0.15, zMax = 1.43;
    const cx = (xMin + xMax) * 0.5;   // -0.99
    const cz = (zMin + zMax) * 0.5;   // +0.64
    const w = xMax - xMin;            // 1.24
    const d = zMax - zMin;            // 1.58
    const floorY = FLOOR_Y;           // -1.20

    // 1. Blind dark steel housing box below the floor cutout so the arcade floor behind never shows through
    const wellDepth = 1.35;
    const wellY = floorY - wellDepth * 0.5 - 0.01;
    const wallThick = 0.035;
    const leftWall = new THREE.Mesh(new THREE.BoxGeometry(wallThick, wellDepth, d + 0.04), darkHousingMat);
    leftWall.position.set(xMin + wallThick * 0.5, wellY, cz);
    g.add(leftWall);
    const rightWall = new THREE.Mesh(new THREE.BoxGeometry(wallThick, wellDepth, d + 0.04), darkHousingMat);
    rightWall.position.set(xMax - wallThick * 0.5, wellY, cz);
    g.add(rightWall);
    const backWall = new THREE.Mesh(new THREE.BoxGeometry(w + 0.04, wellDepth, wallThick), darkHousingMat);
    backWall.position.set(cx, wellY, zMin + wallThick * 0.5);
    g.add(backWall);
    const frontWall = new THREE.Mesh(new THREE.BoxGeometry(w + 0.04, wellDepth, wallThick), darkHousingMat);
    frontWall.position.set(cx, wellY, zMax - wallThick * 0.5);
    g.add(frontWall);
    const bottomPlate = new THREE.Mesh(new THREE.BoxGeometry(w + 0.04, wallThick, d + 0.04), throatDarkMat);
    bottomPlate.position.set(cx, floorY - wellDepth, cz);
    g.add(bottomPlate);

    // 2. Brushed stainless-steel perimeter rim flush with the pit floor around the chute opening
    const rimH = 0.032, rimW = 0.065;
    const rimY = floorY + rimH * 0.35;
    const rimFront = new THREE.Mesh(new THREE.BoxGeometry(w + rimW, rimH, rimW), chromeMat);
    rimFront.position.set(cx, rimY, zMax - rimW * 0.3);
    g.add(rimFront);
    const rimBack = new THREE.Mesh(new THREE.BoxGeometry(w + rimW, rimH, rimW), chromeMat);
    rimBack.position.set(cx, rimY, zMin + rimW * 0.3);
    g.add(rimBack);
    const rimLeft = new THREE.Mesh(new THREE.BoxGeometry(rimW, rimH, d), chromeMat);
    rimLeft.position.set(xMin + rimW * 0.3, rimY, cz);
    g.add(rimLeft);
    const rimRight = new THREE.Mesh(new THREE.BoxGeometry(rimW, rimH, d), chromeMat);
    rimRight.position.set(xMax - rimW * 0.3, rimY, cz);
    g.add(rimRight);

    // 3. Main inclined stainless-steel slide: starts high at the back wall (zMin, y = -0.88)
    //    and slopes forward (+Z) and down (-Y) toward the front throat leading to PRIZE OUT.
    const zStart = zMin + 0.03;       // -0.12
    const yStart = floorY + 0.28;     // -0.92 (rises up against back of chute box)
    const zKnee = 0.96;               // front throat drop-off
    const yKnee = floorY - 0.34;      // -1.54
    const dz1 = zKnee - zStart;       // 1.08
    const dy1 = yKnee - yStart;       // -0.62
    const len1 = Math.hypot(dz1, dy1);
    const pitch1 = Math.atan2(-dy1, dz1); // ~30° downward slope toward +Z (PRIZE OUT door)

    const mainSlide = new THREE.Mesh(new THREE.BoxGeometry(w - 0.08, 0.028, len1), steelMat);
    mainSlide.position.set(cx, (yStart + yKnee) * 0.5, (zStart + zKnee) * 0.5);
    mainSlide.rotation.x = pitch1;
    mainSlide.receiveShadow = true;
    g.add(mainSlide);

    // Back vertical stainless riser sealing between yStart and the back rim
    const backRiserH = yStart - floorY + 0.08;
    const backRiser = new THREE.Mesh(new THREE.BoxGeometry(w - 0.08, backRiserH, 0.028), steelMat);
    backRiser.position.set(cx, floorY + backRiserH * 0.5 - 0.03, zStart - 0.01);
    g.add(backRiser);

    // 4. Deep dark throat tunnel at the front of the ramp (z = 0.96..1.40) plunging straight down
    //    into the lower-left PRIZE OUT door so you see the ramp feeding into the door's shaft
    const zEnd = zMax - 0.05;         // 1.38
    const yEnd = floorY - 1.15;       // -2.35
    const dz2 = zEnd - zKnee;
    const dy2 = yEnd - yKnee;
    const len2 = Math.hypot(dz2, dy2);
    const pitch2 = Math.atan2(-dy2, dz2);

    const throatSlide = new THREE.Mesh(new THREE.BoxGeometry(w - 0.14, 0.026, len2), darkHousingMat);
    throatSlide.position.set(cx, (yKnee + yEnd) * 0.5, (zKnee + zEnd) * 0.5);
    throatSlide.rotation.x = pitch2;
    g.add(throatSlide);

    // Curved chrome lip at the knee where the brushed steel ramp drops into the dark PRIZE OUT shaft
    const kneeLipGeo = new THREE.CylinderGeometry(0.024, 0.024, w - 0.10, 14);
    kneeLipGeo.rotateZ(Math.PI * 0.5);
    const kneeLip = new THREE.Mesh(kneeLipGeo, chromeMat);
    kneeLip.position.set(cx, yKnee + 0.008, zKnee);
    g.add(kneeLip);

    // 5. Angled side funnel cheeks (bent sheet-metal wings) that channel balls toward the center trough
    const cheekW = 0.30;
    const cheekRoll = 0.50; // ~29° inward bank
    [-1, 1].forEach((side) => {
      const cheek = new THREE.Mesh(new THREE.BoxGeometry(cheekW, 0.022, len1 * 0.98), steelMat);
      cheek.position.set(
        cx + side * (w * 0.5 - cheekW * 0.42),
        (yStart + yKnee) * 0.5 + 0.072,
        (zStart + zKnee) * 0.5
      );
      cheek.rotation.order = 'XZY';
      cheek.rotation.x = pitch1;
      cheek.rotation.z = -side * cheekRoll;
      cheek.receiveShadow = true;
      g.add(cheek);
    });

    // 6. Longitudinal polished chrome guide rails along the ramp pointing toward the front door
    const railGeo = new THREE.CylinderGeometry(0.015, 0.015, len1 * 0.94, 12);
    railGeo.rotateX(Math.PI * 0.5);
    [-0.28, -0.09, 0.09, 0.28].forEach((rx) => {
      const rail = new THREE.Mesh(railGeo, chromeMat);
      rail.position.set(
        cx + rx,
        (yStart + yKnee) * 0.5 + 0.021,
        (zStart + zKnee) * 0.5
      );
      rail.rotation.x = pitch1;
      g.add(rail);
    });

    // 7. Narrow front stainless apron sealing the gap between the front floor edge and zMax of vidrio_buzon
    const frontApron = new THREE.Mesh(new THREE.BoxGeometry(w + 0.08, 0.026, 0.28), steelMat);
    frontApron.position.set(cx, floorY + 0.002, zMax + 0.12);
    g.add(frontApron);
  }

  // --- A. Fixed Z rails + mobile X bridge fitted flush to the cabinet roof frame ---
  _buildGantry() {
    const chrome = new THREE.MeshStandardMaterial({ color: 0xf8fafc, metalness: 0.96, roughness: 0.08 });
    const bracket = new THREE.MeshStandardMaterial({ color: 0x334155, metalness: 0.82, roughness: 0.28 });
    const bumper = new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.85, metalness: 0.15 });

    this.gantryGroup = new THREE.Group();
    this.rigGroup.add(this.gantryGroup);

    const zRailLen = RAIL_Z_MAX - RAIL_Z_MIN;
    const zMid = (RAIL_Z_MAX + RAIL_Z_MIN) * 0.5;

    // Clean interior ceiling plate above the gantry so looking up shows a solid finished roof
    const ceilingPlate = new THREE.Mesh(
      new THREE.BoxGeometry(RAIL_X * 2.08, 0.05, zRailLen + 0.08),
      new THREE.MeshStandardMaterial({ color: 0x1e1b2e, metalness: 0.4, roughness: 0.65 })
    );
    ceilingPlate.position.set(0, RAIL_Y + 0.11, zMid);
    this.gantryGroup.add(ceilingPlate);

    const zRailGeo = new THREE.CylinderGeometry(0.028, 0.028, zRailLen, 20);
    const zBeamGeo = new THREE.BoxGeometry(0.065, 0.075, zRailLen);
    const endCapGeo = new THREE.BoxGeometry(0.11, 0.14, 0.09);

    [-RAIL_X, RAIL_X].forEach((rx) => {
      const side = new THREE.Group();
      side.position.set(rx, RAIL_Y, zMid);

      // Upper dark mounting channel flush against the cabinet ceiling side trim
      const beam = new THREE.Mesh(zBeamGeo, bracket);
      beam.position.y = 0.055;
      side.add(beam);

      // Polished chrome guide rod
      const rail = new THREE.Mesh(zRailGeo, chrome);
      rail.rotation.x = Math.PI * 0.5;
      rail.castShadow = true;
      side.add(rail);

      // Front & rear end-stop brackets bolted to the front/rear corner pillars
      [-zRailLen * 0.5 + 0.04, zRailLen * 0.5 - 0.04].forEach((bz) => {
        const cap = new THREE.Mesh(endCapGeo, bumper);
        cap.position.set(0, 0.02, bz);
        side.add(cap);
      });

      this.gantryGroup.add(side);
    });

    // Mobile X bridge (two polished chrome bars + end roller carriages riding on the Z rails)
    this.mobileBridge = new THREE.Group();
    this.gantryGroup.add(this.mobileBridge);

    const xSpan = RAIL_X * 2;
    const xRailGeo = new THREE.CylinderGeometry(0.024, 0.024, xSpan, 24);
    [-0.085, 0.085].forEach((rz) => {
      const r = new THREE.Mesh(xRailGeo, chrome);
      r.rotation.z = Math.PI * 0.5;
      r.position.set(0, BRIDGE_Y, rz);
      r.castShadow = true;
      this.mobileBridge.add(r);
    });

    const truckGeo = new THREE.BoxGeometry(0.12, 0.14, 0.28);
    [-RAIL_X, RAIL_X].forEach((tx) => {
      const truck = new THREE.Mesh(truckGeo, bracket);
      truck.position.set(tx, RAIL_Y - 0.02, 0);
      this.mobileBridge.add(truck);
    });
  }

  // --- B. White arcade trolley carriage with spinning winch drum ---
  _buildTrolley() {
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, metalness: 0.8, roughness: 0.2 });
    this.trolley = new THREE.Group();
    this.trolley.position.set(0, TROLLEY_Y, 0);
    this.rigGroup.add(this.trolley);

    const housing = new THREE.Mesh(
      new THREE.BoxGeometry(0.46, 0.22, 0.34),
      new THREE.MeshStandardMaterial({ color: 0xf8fafc, metalness: 0.15, roughness: 0.32 })
    );
    housing.castShadow = true;
    this.trolley.add(housing);

    // Caution stripes on the trolley face
    const caution = document.createElement('canvas');
    caution.width = 128; caution.height = 32;
    const cx = caution.getContext('2d');
    cx.fillStyle = '#fbbf24'; cx.fillRect(0, 0, 128, 32);
    cx.fillStyle = '#111827';
    for (let i = -1; i < 10; i++) {
      cx.beginPath();
      cx.moveTo(i * 20, 32); cx.lineTo(i * 20 + 14, 0);
      cx.lineTo(i * 20 + 26, 0); cx.lineTo(i * 20 + 12, 32);
      cx.fill();
    }
    const strip = new THREE.Mesh(
      new THREE.PlaneGeometry(0.4, 0.06),
      new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(caution) })
    );
    strip.position.set(0, 0.045, 0.171);
    this.trolley.add(strip);

    // Front circular winch drum (rotates with paid-out cable)
    this.winchDrum = new THREE.Group();
    this.winchDrum.position.set(0.02, -0.01, 0.175);
    this.trolley.add(this.winchDrum);
    const drum = new THREE.Mesh(
      new THREE.CylinderGeometry(0.078, 0.078, 0.025, 24),
      new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.35, metalness: 0.6 })
    );
    drum.rotation.x = Math.PI * 0.5;
    this.winchDrum.add(drum);
    const crescent = new THREE.Mesh(
      new THREE.BoxGeometry(0.045, 0.018, 0.03),
      new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.3 })
    );
    crescent.position.set(0.038, 0.02, 0.004);
    this.winchDrum.add(crescent);

    // Center winch rope nozzle + left coiled-spring strain-relief boot
    this.cordNozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.03, 0.055, 16), wheelMat);
    this.cordNozzle.position.set(0.02, -0.12, 0);
    this.trolley.add(this.cordNozzle);

    this.springBracket = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.028, 0.055, 16), wheelMat);
    this.springBracket.position.set(-LATERAL_OFFSET, -0.12, 0);
    this.trolley.add(this.springBracket);
  }

  // --- C. Clearly visible central load-bearing winch rope + coiled umbilical spring ---
  _buildCords() {
    this.cordCurve = new TensionCordCurve();
    this.cordCurve.top.set(0.02, TOP_CARRIAGE_Y, 0);
    this.cordCurve.bottom.set(0.02, 1.4, 0);

    // High-contrast crimson/red braided winch rope so the load-bearing rope is always clearly visible
    this.centralCable = new THREE.Mesh(
      new THREE.TubeGeometry(this.cordCurve, 16, CORD_TUBE, 10, false),
      new THREE.MeshStandardMaterial({
        color: 0xef4444,
        emissive: 0x7f1d1d,
        emissiveIntensity: 0.35,
        roughness: 0.35,
        metalness: 0.25
      })
    );
    this.centralCable.castShadow = true;
    this.rigGroup.add(this.centralCable);

    this.springMat = new THREE.MeshStandardMaterial({
      color: 0x94a3b8,
      metalness: 0.65,
      roughness: 0.32
    });
    this.springMesh = new THREE.Mesh(
      new THREE.TubeGeometry(
        new DynamicClawSpringCurve(
          _topAnchor.set(-LATERAL_OFFSET, TOP_CARRIAGE_Y, 0),
          _clawAnchor.set(-0.11, 1.4, 0),
          SPRING_COILS, SPRING_RADIUS, LATERAL_OFFSET
        ),
        SPRING_COILS * 20, SPRING_TUBE, 10, false
      ),
      this.springMat
    );
    this.springMesh.castShadow = true;
    this.rigGroup.add(this.springMesh);
  }

  // --- D. Chrome 4-bar linkage claw (3 curved prongs, port of studio claw) ---
  _buildClaw() {
    const chrome = new THREE.MeshStandardMaterial({ color: 0xf8fafc, metalness: 0.98, roughness: 0.07 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1e293b, metalness: 0.85, roughness: 0.22 });

    this.clawGroup = new THREE.Group();
    this.clawGroup.scale.setScalar(CLAW_SCALE);
    this.rigGroup.add(this.clawGroup);

    const upperBell = new THREE.Mesh(new THREE.CylinderGeometry(0.115, 0.115, 0.19, 28), chrome);
    upperBell.position.y = 0.04;
    upperBell.castShadow = true;
    this.clawGroup.add(upperBell);

    const lowerBell = new THREE.Mesh(new THREE.CylinderGeometry(0.095, 0.092, 0.055, 28), chrome);
    lowerBell.position.y = -0.075;
    lowerBell.castShadow = true;
    this.clawGroup.add(lowerBell);

    const topCap = new THREE.Mesh(new THREE.CylinderGeometry(0.082, 0.11, 0.035, 24), dark);
    topCap.position.y = 0.145;
    this.clawGroup.add(topCap);

    // Central rope shackle / eyelet on top of the claw head
    this.cordEyelet = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.03, 0.048, 16), chrome);
    this.cordEyelet.position.set(0.015, 0.18, 0);
    this.clawGroup.add(this.cordEyelet);

    // Side strain-relief boot where the coiled spring plugs in
    this.clawCableBracket = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.022, 0.055, 14), dark);
    this.clawCableBracket.rotation.z = 0.48;
    this.clawCableBracket.position.set(-0.085, 0.115, 0);
    this.clawGroup.add(this.clawCableBracket);

    this.ledMat = new THREE.MeshStandardMaterial({
      color: 0x3b82f6, emissive: 0x2563eb, emissiveIntensity: 0.9, roughness: 0.2
    });
    const led = new THREE.Mesh(new THREE.TorusGeometry(0.092, 0.008, 12, 28), this.ledMat);
    led.rotation.x = Math.PI * 0.5;
    led.position.y = 0.138;
    this.clawGroup.add(led);

    this.plungerRod = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.16, 16), chrome);
    this.plungerRod.position.y = -0.13;
    this.clawGroup.add(this.plungerRod);

    this.spiderCollar = new THREE.Group();
    this.spiderCollar.position.y = -0.16;
    this.clawGroup.add(this.spiderCollar);
    this.spiderCollar.add(new THREE.Mesh(new THREE.CylinderGeometry(0.048, 0.048, 0.036, 20), chrome));

    const cCurve = new THREE.QuadraticBezierCurve3(
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0.135, -0.115, 0),
      new THREE.Vector3(-0.045, -0.315, 0)
    );
    this._fingerCurve = cCurve;
    const fingerGeo = new THREE.TubeGeometry(cCurve, 22, 0.014, 10, false);

    for (let i = 0; i < 3; i++) {
      const angle = (i * Math.PI * 2) / 3 + Math.PI / 6;
      const radial = new THREE.Group();
      radial.rotation.y = -angle;
      this.clawGroup.add(radial);

      const lug = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.028, 0.026), dark);
      lug.position.set(0.095, 0.11, 0);
      radial.add(lug);

      const knuckle = new THREE.Group();
      knuckle.position.set(0.145, -0.16, 0);
      radial.add(knuckle);
      knuckle.add(new THREE.Mesh(new THREE.BoxGeometry(0.042, 0.034, 0.032), chrome));
      const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.038, 10), dark);
      pin.rotation.x = Math.PI * 0.5;
      knuckle.add(pin);
      const finger = new THREE.Mesh(fingerGeo, chrome);
      finger.castShadow = true;
      knuckle.add(finger);
      const tip = new THREE.Mesh(new THREE.ConeGeometry(0.014, 0.048, 10), chrome);
      tip.position.set(-0.052, -0.325, 0);
      tip.rotation.z = -1.05;
      knuckle.add(tip);

      const strut = new THREE.Mesh(new THREE.BoxGeometry(0.018, 1.0, 0.024), chrome);
      strut.castShadow = true;
      radial.add(strut);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.018, 1.0, 0.022), chrome);
      arm.castShadow = true;
      radial.add(arm);

      this.prongRigs.push({
        radial, knuckle, strut, arm,
        lugPos: new THREE.Vector3(0.095, 0.11, 0),
        spiderLug: new THREE.Vector3(0.038, 0, 0),
        knuckleLocal: new THREE.Vector3()
      });
    }
  }

  _alignBar(bar, pA, pB) {
    _tmpA.subVectors(pB, pA);
    const len = Math.max(0.001, _tmpA.length());
    bar.position.lerpVectors(pA, pB, 0.5);
    bar.scale.set(1, len, 1);
    bar.quaternion.setFromUnitVectors(_up, _tmpA.normalize());
  }

  // Verse dealing — the pool is stocked once (shuffled deck of pool indices);
  // every prize draws the next card and the deck reshuffles when exhausted.
  setVerseDeck(deck) {
    this.verseDeck = deck;
    this._deckPos = 0;
    // Prizes may already exist (deck loads async) — deal everyone now.
    if (this.prizes) for (const pr of this.prizes) pr.verseIdx = this._dealVerseIdx();
  }

  _dealVerseIdx() {
    if (!this.verseDeck || !this.verseDeck.length) return -1;
    if (this._deckPos >= this.verseDeck.length) {
      // Fresh shuffle when the deck runs out — the machine re-stocks itself.
      for (let i = this.verseDeck.length - 1; i > 0; i--) {
        const j = (Math.random() * (i + 1)) | 0;
        [this.verseDeck[i], this.verseDeck[j]] = [this.verseDeck[j], this.verseDeck[i]];
      }
      this._deckPos = 0;
    }
    return this.verseDeck[this._deckPos++];
  }

  // --- E. Sphere prizes only (no plush toys) spread across the cabinet floor ---
  _buildPrizes() {
    this.prizeGroup = new THREE.Group();
    this.rigGroup.add(this.prizeGroup);

    const capPalette = [0xf43f5e, 0x3b82f6, 0x10b981, 0xfbbf24, 0xa855f7];
    const capSpots = [
      [0.15, 0.82], [0.55, 0.95], [1.12, 0.78], [0.72, -0.15],
      [1.15, -0.25], [0.05, -0.62], [-0.72, -0.78], [0.78, -0.92],
      [0.08, 0.55], [0.48, 0.02]
    ];
    capSpots.forEach(([tx, tz], i) => {
      const cg = new THREE.Group();
      const cap = new THREE.Mesh(
        new THREE.SphereGeometry(0.115, 16, 16),
        new THREE.MeshStandardMaterial({ color: capPalette[i % capPalette.length], roughness: 0.2, metalness: 0.1 })
      );
      cap.castShadow = true;
      cg.add(cap);
      const homePos = new THREE.Vector3(tx, -0.5, tz);
      const homeRot = new THREE.Euler(0, i * 0.5, 0);
      cg.position.copy(homePos);
      this.prizeGroup.add(cg);
      const pr = { name: `Cápsula #${i + 1}`, mesh: cg, homePos, homeRot, radius: 0.16, grabbed: false, droppingInChute: false, fallVel: 0, verseIdx: this._dealVerseIdx() };
      this.prizes.push(pr);
      this._addBody(pr, 0.35, 0.35, [{ off: new THREE.Vector3(0, 0, 0), r: 0.115 }], 0.16);
    });

    // --- Deep ball pit: glassy transmissive prize balls on top layers,
    //     standard glossy below (buried ones are occluded anyway) ---
    const ballPalette = [0xf43f5e, 0x3b82f6, 0x10b981, 0xfbbf24, 0xa855f7, 0xf97316, 0x22d3ee, 0xe879f9];
    const glassMats = ballPalette.map((hex) => new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      transmission: 0.92,
      thickness: 0.09,
      roughness: 0.05,
      metalness: 0,
      ior: 1.42,
      attenuationColor: new THREE.Color(hex),
      attenuationDistance: 0.13,
      clearcoat: 1.0,
      clearcoatRoughness: 0.08,
      specularIntensity: 1.0,
      envMapIntensity: 1.15
    }));
    const solidMats = ballPalette.map((hex) => new THREE.MeshStandardMaterial({
      color: hex, roughness: 0.18, metalness: 0.15
    }));
    glassMats.forEach((m, i) => { m.userData.hex = ballPalette[i]; });
    this._glassMats = glassMats;
    const ballItems = [];
    const ball = (bx, by, bz, i, glassy = false) => {
      const r = 0.10 + ((i * 37) % 5) * 0.008;
      const bg = new THREE.Group();
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(r, 14, 12),
        (glassy ? glassMats : solidMats)[i % ballPalette.length]
      );
      // drawn through the per-material InstancedMesh below; kept as the prize's color source
      m.visible = false;
      bg.add(m);
      ballItems.push({ bg, r, mat: m.material });
      const homePos = new THREE.Vector3(bx, by, bz);
      const homeRot = new THREE.Euler(0, i * 0.7, 0);
      bg.position.copy(homePos);
      this.prizeGroup.add(bg);
      const pr = { name: `Pelota #${i + 1}`, mesh: bg, homePos, homeRot, radius: r + 0.02, grabbed: false, droppingInChute: false, fallVel: 0, verseIdx: this._dealVerseIdx() };
      this.prizes.push(pr);
      this._addBody(pr, 0.30, 0.42, [{ off: new THREE.Vector3(0, 0, 0), r }], r + 0.04);
    };

    let ballIdx = 0;
    // 5 layers filling the pit toward the glass — density thins toward the top
    // so it reads like a real piled pit, with plushies resting half-buried on top
    const layers = [
      { y: -1.07, step: 0.32, keep: 1.00, avoidPlush: true },
      { y: -0.82, step: 0.30, keep: 0.78 },
      { y: -0.57, step: 0.31, keep: 0.66 },
      { y: -0.33, step: 0.34, keep: 0.55 },
      { y: -0.12, step: 0.42, keep: 0.42 }
    ];
    for (const [li, L] of layers.entries()) {
      for (let gx = -1.5; gx <= 1.55; gx += L.step) {
        for (let gz = -1.55; gz <= 1.55; gz += L.step) {
          const h = Math.sin(gx * 12.9 + gz * 7.7 + li * 3.3) * 0.5 + 0.5;
          if (h > L.keep) continue;
          const bx = gx + Math.sin(gx * 7.3 + gz * 3.1 + li) * 0.05;
          const bz = gz + Math.cos(gx * 5.1 - gz * 6.7 + li * 2.0) * 0.05;
          if (bx > CHUTE_BOX.xMin - 0.26 && bx < CHUTE_BOX.xMax + 0.26 &&
              bz > CHUTE_BOX.zMin - 0.26 && bz < CHUTE_BOX.zMax + 0.26) continue;
          if (L.avoidPlush && this.prizes.some(p => Math.hypot(p.homePos.x - bx, p.homePos.z - bz) < 0.30)) continue;
          ball(bx, L.y + Math.sin(bx * 11 + bz * 13) * 0.03, bz, ballIdx++, li >= 3);
        }
      }
    }

    // ~200 balls share 16 materials: one instanced draw per material instead of one per ball
    const unitBall = new THREE.SphereGeometry(1, 14, 12);
    this._ballInst = [...glassMats, ...solidMats].map((mat) => {
      const items = ballItems.filter((b) => b.mat === mat);
      if (!items.length) return null;
      const im = new THREE.InstancedMesh(unitBall, mat, items.length);
      im.castShadow = true;
      im.frustumCulled = false;
      this.prizeGroup.add(im);
      return { im, items };
    }).filter(Boolean);
    this.syncBallInstances();
  }

  syncBallInstances() {
    for (const { im, items } of this._ballInst) {
      for (let i = 0; i < items.length; i++) {
        const { bg, r } = items[i];
        _instScale.set(r, r, r).multiply(bg.scale);
        _instMat.compose(bg.position, bg.quaternion, _instScale);
        im.setMatrixAt(i, _instMat);
      }
      im.instanceMatrix.needsUpdate = true;
    }
  }

  // ------------------------------------------------------------------
  // Rigid-body prize physics engine (real impulses, substepped)
  // ------------------------------------------------------------------
  _addBody(pr, mass, restitution, spheres, broadR) {
    pr.body = {
      pos: pr.mesh.position,
      vel: new THREE.Vector3(),
      quat: new THREE.Quaternion().setFromEuler(pr.homeRot),
      angVel: new THREE.Vector3(),
      invMass: 1 / mass,
      restitution,
      friction: 0.55,
      spheres,
      broadR,
      asleep: false,
      sleepT: 0,
      contacted: false
    };
    pr.mesh.quaternion.copy(pr.body.quat);
  }

  // Compute the 16 claw colliders (bell + 3 knuckles + 4-node chain per finger) in rig space
  _clawColliders(openRatio, out) {
    const swayX = this.phys.swayAngle + (this.phys.groundTiltX || 0);
    const swayZ = this.phys.swayAngleZ + (this.phys.groundTiltZ || 0);
    _euler.set(swayZ, 0, swayX);
    const cp = this.clawGroup.position;
    // Central bell head
    out[0].pos.set(0, -0.02 * CLAW_SCALE, 0).applyEuler(_euler).add(cp);
    out[0].r = 0.13 * CLAW_SCALE;
    const fp = -0.18 + openRatio * 0.72;
    const cosF = Math.cos(fp), sinF = Math.sin(fp);
    const NODE_T = [0.30, 0.55, 0.78, 0.97];
    const NODE_R = [0.055, 0.052, 0.048, 0.042];
    let k = 1;
    for (let i = 0; i < 3; i++) {
      const a = (i * Math.PI * 2) / 3 + Math.PI / 6;
      const ca = Math.cos(a), sa = Math.sin(a);
      // Knuckle hinge block
      out[k].pos
        .set(0.145 * ca * CLAW_SCALE, -0.16 * CLAW_SCALE, 0.145 * sa * CLAW_SCALE)
        .applyEuler(_euler)
        .add(cp);
      out[k].r = 0.055 * CLAW_SCALE;
      k++;
      // Contact chain along the real C-curve (knuckle-local -> radial -> claw space)
      for (let j = 0; j < 4; j++) {
        const p = this._fingerCurve.getPoint(NODE_T[j]);
        const rx = p.x * cosF - p.y * sinF;
        const ry = p.x * sinF + p.y * cosF;
        const lx = 0.145 + rx, ly = -0.16 + ry;
        out[k].pos
          .set(lx * ca * CLAW_SCALE, ly * CLAW_SCALE, lx * sa * CLAW_SCALE)
          .applyEuler(_euler)
          .add(cp);
        out[k].r = NODE_R[j] * CLAW_SCALE;
        k++;
      }
    }
  }

  // Where do the finger tips land? Highest support under bell + each tip
  // (pit floor or a plush top) -> contact drop + lean direction.
  _clawSupport() {
    const cx = this.anim.smoothTX, cz = this.anim.smoothTZ;
    const fp = -0.18 + this.anim.currentOpen * 0.72;
    const tipY = (-0.16 - 0.34 * Math.cos(fp)) * CLAW_SCALE;
    const tipR = (0.145 + 0.34 * Math.sin(fp)) * CLAW_SCALE;
    let centerY = FLOOR_Y;
    const tips = [FLOOR_Y, FLOOR_Y, FLOOR_Y];
    let pushOff = null;
    for (const pr of this.prizes) {
      const b = pr.body;
      if (!b || pr.grabbed || pr.droppingInChute) continue;
      for (const s of b.spheres) {
        const sc = this._sphereWorldCenter(b, s, _tmpA);
        const top = sc.y + s.r;
        const dc = Math.hypot(sc.x - cx, sc.z - cz);
        if (dc < 0.30 + s.r && top > centerY) {
          centerY = top;
          pushOff = { x: sc.x, z: sc.z, top };
        }
        for (let i = 0; i < 3; i++) {
          const a = (i * Math.PI * 2) / 3 + Math.PI / 6;
          const tx = cx + Math.cos(a) * tipR, tz = cz + Math.sin(a) * tipR;
          if (Math.hypot(sc.x - tx, sc.z - tz) < 0.24 + s.r && top > tips[i]) tips[i] = top;
        }
      }
    }
    // Real machines don't stop on top of the pile: the thin finger tips STAB
    // into it (their colliders shove balls aside) and the claw stops when the
    // BELL bottoms out on a prize. Contact = bell contact, not tip contact.
    const supportY = Math.max(centerY, tips[0], tips[1], tips[2]);
    const clawY0 = TOP_CARRIAGE_Y - CLAW_HANG;
    const bellContact = clawY0 - 0.198 - centerY;             // bell bottom sphere hits
    const tipFloorLimit = clawY0 - (FLOOR_Y - 0.08 - tipY);    // tips may dig ~0.08 under
    // While closing, the winch keeps pressing down: the fingers burrow UNDER
    // the prize and scoop it (real motor-down-while-closing behavior)
    const digBoost = this.phase === 'grabbing' ? 0.14 : 0;
    const drop = Math.min(DROP_MAX, Math.min(bellContact, tipFloorLimit) + digBoost);
    const mean = (tips[0] + tips[1] + tips[2]) / 3;
    let tiltX = 0, tiltZ = 0;
    for (let i = 0; i < 3; i++) {
      const a = (i * Math.PI * 2) / 3 + Math.PI / 6;
      tiltX += Math.cos(a) * (mean - tips[i]);
      tiltZ += Math.sin(a) * (mean - tips[i]);
    }
    // Plush under the bell pushes the claw off its crown -> lean away from it
    if (centerY > mean + 0.10 && pushOff) {
      const dx = cx - pushOff.x, dz = cz - pushOff.z;
      const d = Math.hypot(dx, dz) || 1;
      tiltX += (dx / d) * (centerY - mean) * 0.8;
      tiltZ += (dz / d) * (centerY - mean) * 0.8;
    }
    const mag = Math.hypot(tiltX, tiltZ);
    if (mag > 0.30) { tiltX *= 0.30 / mag; tiltZ *= 0.30 / mag; }
    return { drop, tiltX, tiltZ, supportY };
  }

  _sphereWorldCenter(body, s, out) {
    return out.copy(s.off).applyQuaternion(body.quat).add(body.pos);
  }

  _stepPrizePhysics(dt) {
    const anim = this.anim;
    const sub = Math.max(1, PHYS_SUBSTEPS);
    const h = Math.min(0.04, dt) / sub;

    // Claw collider centers + REAL per-collider velocity — the finger chain
    // carries its actual closing sweep speed into the impulse math
    const cols = this._colliders;
    this._clawColliders(anim.currentOpen, cols);
    const invDt = 1 / Math.max(0.001, dt);
    for (const col of cols) {
      if (!col.prev) { col.prev = col.pos.clone(); col.vel = new THREE.Vector3(); }
      col.vel.subVectors(col.pos, col.prev).multiplyScalar(invDt);
      col.prev.copy(col.pos);
    }
    const clawApproachSpeed = Math.abs(this.phys.dropVelocity);
    const clawPush = new THREE.Vector3(anim.trolleyVelX, -this.phys.dropVelocity, anim.trolleyVelZ);

    // Sleep bookkeeping: reset contact flags once per frame
    for (const pr of this.prizes) if (pr.body) pr.body.contacted = false;

    for (let s = 0; s < sub; s++) {
      for (const pr of this.prizes) {
        const b = pr.body;
        if (!b || pr.grabbed || b.asleep) continue;
        // Won & falling inside the chute still simulates (falls into bin)
        const inHole = pr.droppingInChute && Math.hypot(b.pos.x - CHUTE_BOX.holeX, b.pos.z - CHUTE_BOX.holeZ) < CHUTE_BOX.holeR;
        const bx0 = CHUTE_BOX;
        // Only a prize that enters the chute opening from ABOVE the rim
        // (dropped by the claw or knocked over the top edge) enters the chute
        if (!pr.droppingInChute &&
            b.pos.x > bx0.xMin + 0.08 && b.pos.x < bx0.xMax - 0.08 &&
            b.pos.z > bx0.zMin + 0.08 && b.pos.z < bx0.zMax - 0.08 &&
            b.pos.y >= bx0.topY - 0.16 && b.vel.y <= 0) {
          pr.droppingInChute = true;
        }
        b.vel.y += PHYS_G * h;
        b.vel.clampLength(0, 4.5);
        b.pos.addScaledVector(b.vel, h);

        // Floor: pit floor everywhere outside the chute; inside the chute, balls land on the
        // inclined stainless-steel ramp and roll forward (+Z) into the front throat (z > 1.04).
        const minSphereY = b.pos.y - Math.max(...b.spheres.map(sp => sp.r)) * 0.8;
        const inChuteFootprint = b.pos.x > bx0.xMin && b.pos.x < bx0.xMax && b.pos.z > bx0.zMin && b.pos.z < bx0.zMax;
        if (pr.droppingInChute || inChuteFootprint) {
          pr.droppingInChute = true;
          // Ramp surface height: slopes from y = -0.92 at z = -0.12 down to y = -1.54 at z = 0.96, then plunges
          const rampT = Math.max(0, Math.min(1, (b.pos.z - (-0.12)) / 1.08));
          const rampY = b.pos.z < 0.96 ? (-0.92 - rampT * 0.62) : (-1.54 - (b.pos.z - 0.96) * 2.4);
          if (minSphereY < rampY) {
            b.pos.y += rampY - minSphereY;
            if (b.vel.y < 0) b.vel.y = -b.vel.y * 0.25;
            // Accelerate down the metal slope toward the front PRIZE OUT throat (+Z) and center trough
            b.vel.z += 5.8 * h;
            b.vel.x += (bx0.holeX - b.pos.x) * 7.0 * h;
          }
        } else if (!inHole && minSphereY < FLOOR_Y) {
          b.contacted = true;
          b.pos.y += FLOOR_Y - minSphereY;
          if (b.vel.y < 0) {
            b.vel.y = -b.vel.y * b.restitution;
            if (Math.abs(b.vel.y) < 0.12) b.vel.y = 0;
          }
          // Rolling friction + tumble spin (real: v x n / r)
          b.vel.x *= 1 - Math.min(0.85, b.friction * 6.0 * h);
          b.vel.z *= 1 - Math.min(0.85, b.friction * 6.0 * h);
          const spin = Math.hypot(b.vel.x, b.vel.z);
          if (spin > 0.02) {
            _tmpA.set(b.vel.z / spin, 0, -b.vel.x / spin); // rotation axis = n x v
            const ang = (spin / 0.14) * h;
            b.quat.premultiply(new THREE.Quaternion().setFromAxisAngle(_tmpA, Math.min(0.5, ang)));
          }
          b.angVel.multiplyScalar(0.95);
        } else {
          // Airborne tumble while flying through the cabinet
          const spd = b.vel.length();
          if (spd > 0.4) {
            b.quat.premultiply(new THREE.Quaternion().setFromAxisAngle(_tmpA.set(0.4, 0.6, 0.3).normalize(), Math.min(0.3, h * spd)));
          }
        }

        // Outer glass walls
        if (b.pos.x - b.broadR * 0.5 < WALL_X_MIN) { b.pos.x = WALL_X_MIN + b.broadR * 0.5; b.vel.x = Math.abs(b.vel.x) * b.restitution; }
        if (b.pos.x + b.broadR * 0.5 > WALL_X_MAX) { b.pos.x = WALL_X_MAX - b.broadR * 0.5; b.vel.x = -Math.abs(b.vel.x) * b.restitution; }
        if (b.pos.z - b.broadR * 0.5 < WALL_Z_MIN) { b.pos.z = WALL_Z_MIN + b.broadR * 0.5; b.vel.z = Math.abs(b.vel.z) * b.restitution; }
        if (b.pos.z + b.broadR * 0.5 > WALL_Z_MAX) { b.pos.z = WALL_Z_MAX - b.broadR * 0.5; b.vel.z = -Math.abs(b.vel.z) * b.restitution; }

        // Chute box walls: if outside footprint -> collide with outer walls; inside -> inner walls
        const bx = CHUTE_BOX;
        // A prize released/knocked into the chute is guided through the hole
        if (pr.droppingInChute) {
          b.vel.x += (CHUTE_BOX.holeX - b.pos.x) * 6 * h;
          b.vel.z += (CHUTE_BOX.holeZ - b.pos.z) * 6 * h;
        }

        const insideX = b.pos.x > bx.xMin && b.pos.x < bx.xMax;
        const insideZ = b.pos.z > bx.zMin && b.pos.z < bx.zMax;
        const belowTop = b.pos.y - b.broadR * 0.4 < bx.topY;
        if (belowTop) {
          if (!pr.droppingInChute) {
            // Outside prizes in the pit cannot penetrate the chute box walls
            const pad = b.broadR * 0.5;
            if (b.pos.x > bx.xMin - pad && b.pos.x < bx.xMax + pad &&
                b.pos.z > bx.zMin - pad && b.pos.z < bx.zMax + pad) {
              const dRight = Math.abs((bx.xMax + pad) - b.pos.x);
              const dFront = Math.abs((bx.zMax + pad) - b.pos.z);
              const dBack = Math.abs(b.pos.z - (bx.zMin - pad));
              if (dRight <= dFront && dRight <= dBack) {
                b.pos.x = bx.xMax + pad;
                b.vel.x = Math.max(0, Math.abs(b.vel.x) * b.restitution);
              } else if (dFront <= dBack) {
                b.pos.z = bx.zMax + pad;
                b.vel.z = Math.max(0, Math.abs(b.vel.z) * b.restitution);
              } else {
                b.pos.z = bx.zMin - pad;
                b.vel.z = Math.min(0, -Math.abs(b.vel.z) * b.restitution);
              }
            }
          } else {
            // Inside the box: constrain to inner walls, fall through hole
            if (b.pos.x - b.broadR * 0.5 < bx.xMin) { b.pos.x = bx.xMin + b.broadR * 0.5; b.vel.x = Math.abs(b.vel.x) * b.restitution; }
            if (b.pos.x + b.broadR * 0.5 > bx.xMax) { b.pos.x = bx.xMax - b.broadR * 0.5; b.vel.x = -Math.abs(b.vel.x) * b.restitution; }
            if (b.pos.z - b.broadR * 0.5 < bx.zMin) { b.pos.z = bx.zMin + b.broadR * 0.5; b.vel.z = Math.abs(b.vel.z) * b.restitution; }
            if (b.pos.z + b.broadR * 0.5 > bx.zMax) { b.pos.z = bx.zMax - b.broadR * 0.5; b.vel.z = -Math.abs(b.vel.z) * b.restitution; }
            // Inside the hole: free fall -> prize won!
            if (inHole && b.pos.y < -1.4 && !pr.countedWon) {
              pr.countedWon = true;
              this.prizesWon += 1;
              this.lastWonPrize = pr.name;
              if (this.onPrizeWon) this.onPrizeWon(this.prizesWon, pr);
            }
          }
        }

        // Respawn once below the bin — re-stocked with a fresh dealt verse
        if (b.pos.y < CHUTE_KILL_Y) {
          pr.droppingInChute = false;
          pr.countedWon = false;
          pr.grabbed = false;
          pr.verseIdx = this._dealVerseIdx();
          b.vel.set(0, 0, 0);
          b.angVel.set(0, 0, 0);
          b.pos.copy(pr.homePos);
          b.quat.setFromEuler(pr.homeRot);
        }

        pr.mesh.quaternion.copy(b.quat);
      }

      // Prize <-> prize collisions (sphere-sphere, impulse + positional)
      for (let i = 0; i < this.prizes.length; i++) {
        const A = this.prizes[i];
        const ba = A.body;
        if (!ba || A.grabbed) continue;
        for (let j = i + 1; j < this.prizes.length; j++) {
          const B = this.prizes[j];
          const bb = B.body;
          if (!bb || B.grabbed) continue;
          if (ba.asleep && bb.asleep) continue;
          const dx = bb.pos.x - ba.pos.x, dy = bb.pos.y - ba.pos.y, dz = bb.pos.z - ba.pos.z;
          const rr = ba.broadR + bb.broadR;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 > rr * rr) continue;
          for (const sa of ba.spheres) {
            const ca = this._sphereWorldCenter(ba, sa, _tmpA);
            for (const sb of bb.spheres) {
              const cb = this._sphereWorldCenter(bb, sb, _tmpB);
              const rsum = sa.r + sb.r;
              const ddx = cb.x - ca.x, ddy = cb.y - ca.y, ddz = cb.z - ca.z;
              const d2s = ddx * ddx + ddy * ddy + ddz * ddz;
              if (d2s >= rsum * rsum || d2s < 1e-8) continue;
              const d = Math.sqrt(d2s);
              const nx = ddx / d, ny = ddy / d, nz = ddz / d;
              const pen = rsum - d;
              // Wake sleeping bodies that get touched
              if (ba.asleep) { ba.asleep = false; ba.sleepT = 0; }
              if (bb.asleep) { bb.asleep = false; bb.sleepT = 0; }
              ba.contacted = bb.contacted = true;
              const wsum = ba.invMass + bb.invMass;
              ba.pos.x -= nx * pen * (ba.invMass / wsum);
              ba.pos.y -= ny * pen * (ba.invMass / wsum);
              ba.pos.z -= nz * pen * (ba.invMass / wsum);
              bb.pos.x += nx * pen * (bb.invMass / wsum);
              bb.pos.y += ny * pen * (bb.invMass / wsum);
              bb.pos.z += nz * pen * (bb.invMass / wsum);
              const rvx = bb.vel.x - ba.vel.x, rvy = bb.vel.y - ba.vel.y, rvz = bb.vel.z - ba.vel.z;
              const vn = rvx * nx + rvy * ny + rvz * nz;
              if (vn < 0) {
                const e = Math.min(ba.restitution, bb.restitution);
                const jimp = (-(1 + e) * vn) / wsum;
                ba.vel.x -= jimp * ba.invMass * nx;
                ba.vel.y -= jimp * ba.invMass * ny;
                ba.vel.z -= jimp * ba.invMass * nz;
                bb.vel.x += jimp * bb.invMass * nx;
                bb.vel.y += jimp * bb.invMass * ny;
                bb.vel.z += jimp * bb.invMass * nz;
              }
            }
          }
        }
      }

      // Claw colliders <-> prizes (16-node BMX chain: bell + knuckles + finger sweep)
      let impactReaction = null;
      for (const pr of this.prizes) {
        const b = pr.body;
        if (!b || pr.grabbed) continue;
        for (const s2 of b.spheres) {
          const cs = this._sphereWorldCenter(b, s2, _tmpA);
          for (const col of cols) {
            const rsum = s2.r + col.r;
            const ddx = cs.x - col.pos.x, ddy = cs.y - col.pos.y, ddz = cs.z - col.pos.z;
            const d2c = ddx * ddx + ddy * ddy + ddz * ddz;
            if (d2c >= rsum * rsum || d2c < 1e-8) continue;
            const d = Math.sqrt(d2c);
            const nx = ddx / d, ny = ddy / d, nz = ddz / d;
            const pen = rsum - d;
            if (b.asleep) { b.asleep = false; b.sleepT = 0; }
            b.contacted = true;
            // Push prize out along normal (capped so squeezed prizes don't
            // get teleported through the cage mouth)
            const corr = pen * 0.75;
            b.pos.x += nx * corr;
            b.pos.y += ny * corr;
            b.pos.z += nz * corr;
            const cvx = col.vel ? col.vel.x : clawPush.x;
            const cvy = col.vel ? col.vel.y : clawPush.y;
            const cvz = col.vel ? col.vel.z : clawPush.z;
            const relVx = b.vel.x - cvx, relVy = b.vel.y - cvy, relVelZ = b.vel.z - cvz;
            const vn = relVx * nx + relVy * ny + relVelZ * nz;
            if (vn < 0) {
              const j = -vn * (1 + b.restitution * 0.5);
              b.vel.x += j * nx * 0.55 + cvx * 0.10;
              b.vel.y += j * ny * 0.55 + cvy * 0.10;
              b.vel.z += j * nz * 0.55 + cvz * 0.10;
              // Two-way: the plush push slows/tilts the claw on hard downward hits
              if (this.phase === 'descending' && clawApproachSpeed > 0.25 && ny > 0.35) {
                impactReaction = { mag: Math.min(1, clawApproachSpeed * vn * -0.8), nx, nz };
              }
            }
            // REAL Coulomb grip: tangential friction at finger contacts, capped
            // by normal force. Closed fingers pinch (high μ); open fingers let
            // prizes slide off like glass. A wedged prize holds via pen-based
            // static friction; too heavy or badly seated -> it slips out.
            const tvx = relVx - vn * nx, tvy = relVy - vn * ny, tvz = relVelZ - vn * nz;
            const tLen = Math.hypot(tvx, tvy, tvz);
            if (tLen > 1e-4) {
              const pinched = anim.currentOpen < 0.45;
              const mu = pinched ? 0.12 + this.gripStrength * 0.9 : 0.15;
              const maxFric = mu * Math.max(-vn * 0.5, pen * 4.0);
              const scale = Math.min(1, maxFric / tLen) * 0.92;
              b.vel.x -= tvx * scale;
              b.vel.y -= tvy * scale;
              b.vel.z -= tvz * scale;
            }
          }
        }
      }
      if (impactReaction) {
        this.phys.dropVelocity *= 0.55;
        this.phys.groundTiltX = THREE.MathUtils.clamp((this.phys.groundTiltX || 0) + impactReaction.nx * impactReaction.mag * 0.35, -0.4, 0.4);
        this.phys.groundTiltZ = THREE.MathUtils.clamp((this.phys.groundTiltZ || 0) + impactReaction.nz * impactReaction.mag * 0.35, -0.4, 0.4);
        this.phys.coilWaveVel += impactReaction.mag * 1.4;
        this.phys.swayVelocity += impactReaction.nx * impactReaction.mag * 0.5;
        this.phys.swayVelocityZ += impactReaction.nz * impactReaction.mag * 0.4;
      }
    }

    // Sleep pass: quiet bodies resting on supports freeze (huge perf win on a
    // deep pile) — they wake when the claw chain or a moving body touches them.
    // Prizes inside the claw cage never sleep (they'd freeze mid-air).
    const cgp = this.clawGroup.position;
    for (const pr of this.prizes) {
      const b = pr.body;
      if (!b || pr.grabbed || b.asleep) continue;
      const nearClaw = Math.hypot(b.pos.x - cgp.x, b.pos.z - cgp.z) < 0.5 &&
                       b.pos.y > cgp.y - 0.85 && b.pos.y < cgp.y + 0.35;
      if (b.contacted && b.vel.lengthSq() < 0.003 && !nearClaw) {
        b.sleepT += dt;
        if (b.sleepT > 0.5) {
          b.asleep = true;
          b.vel.set(0, 0, 0);
          b.angVel.set(0, 0, 0);
        }
      } else {
        b.sleepT = 0;
      }
    }
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------
  takeManualControl() {
    if (!this.autoDemo) return;
    this.autoDemo = false;
    if (this.phase !== 'idle') {
      // Retract and open continuously when a player interrupts the demo.
      this.phase = 'idle';
      this.phaseTimer = 0;
      this.targetTX = this.anim.smoothTX;
      this.targetTZ = this.anim.smoothTZ;
      this.targetDrop = DROP_REST;
      this.targetOpen = 0.82;
    }
  }

  triggerGrabCycle() {
    this.takeManualControl();
    if (this.phase === 'idle') {
      this.phase = 'descending';
      this.phaseTimer = 0;
      this.phys.bouncesCount = 0;
      this.targetOpen = 0.92;
      this.targetDrop = DROP_MAX;
      return true;
    }
    return false;
  }

  nudgeGantry(dx, dz) {
    this.takeManualControl();
    if (this.phase === 'idle') {
      this.targetTX = THREE.MathUtils.clamp(this.targetTX + dx * TRAVEL_X, -TRAVEL_X, TRAVEL_X);
      this.targetTZ = THREE.MathUtils.clamp(this.targetTZ + dz * TRAVEL_Z, -TRAVEL_Z, TRAVEL_Z);
    }
  }

  setPose(p) {
    if (p.x !== undefined) this.anim.smoothTX = this.targetTX = p.x * TRAVEL_X;
    if (p.z !== undefined) this.anim.smoothTZ = this.targetTZ = p.z * TRAVEL_Z;
    if (p.drop !== undefined) this.phys.drop = this.anim.currentDrop = this.targetDrop = p.drop * DROP_MAX;
    if (p.grip !== undefined) this.anim.currentOpen = this.targetOpen = 1 - p.grip;
  }

  apply() {
    this._updateVisuals();
  }

  // ------------------------------------------------------------------
  _updateVisuals() {
    const anim = this.anim;
    const ph = this.phys;
    const dropAmount = anim.currentDrop;
    const clawY = TOP_CARRIAGE_Y - CLAW_HANG - dropAmount;

    // Mobile bridge & trolley
    this.mobileBridge.position.set(0, 0, anim.smoothTZ);
    this.trolley.position.set(anim.smoothTX, TROLLEY_Y, anim.smoothTZ);
    this.clawGroup.position.set(anim.smoothTX, clawY, anim.smoothTZ);
    // Dead landing settle: claw sags sideways into the soft side of the pile
    this.clawGroup.position.x += ph.sagX || 0;
    this.clawGroup.position.z += ph.sagZ || 0;
    // The claw itself is confined by the four glass panes (bell + finger reach)
    this.clawGroup.position.x = THREE.MathUtils.clamp(this.clawGroup.position.x, WALL_X_MIN + 0.30, WALL_X_MAX - 0.30);
    this.clawGroup.position.z = THREE.MathUtils.clamp(this.clawGroup.position.z, WALL_Z_MIN + 0.30, WALL_Z_MAX - 0.30);
    this.winchDrum.rotation.z = dropAmount * 5.2;

    // 2D pendulum + floor-bounce touchdown tilt
    const swayX = ph.swayAngle + (ph.groundTiltX || 0);
    const swayZ = ph.swayAngleZ + (ph.groundTiltZ || 0);
    this.clawGroup.rotation.z = swayX;
    this.clawGroup.rotation.x = swayZ;

    // 4-bar linkage driven by open ratio
    const openRatio = anim.currentOpen;
    const kin = calculateClawProngs(openRatio);
    this.spiderCollar.position.y = kin.plungerOffset;
    this.plungerRod.position.y = kin.plungerOffset * 0.55;
    for (const rig of this.prongRigs) {
      rig.knuckle.rotation.z = kin.fingerPitch;
      rig.knuckleLocal.set(rig.knuckle.position.x, rig.knuckle.position.y, 0);
      this._alignBar(rig.strut, rig.lugPos, rig.knuckleLocal);
      _tmpB.set(rig.spiderLug.x, kin.plungerOffset, 0);
      this._alignBar(rig.arm, _tmpB, rig.knuckleLocal);
    }

    // Status LED tint
    if (openRatio > 0.6) {
      this.ledMat.color.setHex(0x3b82f6); this.ledMat.emissive.setHex(0x2563eb);
    } else if (openRatio < 0.25) {
      this.ledMat.color.setHex(0x10b981); this.ledMat.emissive.setHex(0x059669);
    } else {
      this.ledMat.color.setHex(0xf59e0b); this.ledMat.emissive.setHex(0xd97706);
    }

    // Anchors in rig space:
    // 1. Central load-bearing winch rope from trolley nozzle -> claw top eyelet
    _euler.set(swayZ, 0, swayX);
    _topCord.set(this.trolley.position.x + 0.02, this.trolley.position.y - 0.12, this.trolley.position.z);
    _clawCord.set(0.015 * CLAW_SCALE, 0.18 * CLAW_SCALE, 0).applyEuler(_euler).add(this.clawGroup.position);

    this.cordCurve.top.copy(_topCord);
    this.cordCurve.bottom.copy(_clawCord);
    this.cordCurve.slack = ph.ropeSlack || 0;
    this.centralCable.geometry.dispose();
    this.centralCable.geometry = new THREE.TubeGeometry(this.cordCurve, 16, CORD_TUBE, 10, false);

    // 2. Coiled elastic telephone cord from left trolley bracket -> claw side bracket
    _topAnchor.set(this.trolley.position.x - LATERAL_OFFSET, this.trolley.position.y - 0.12, this.trolley.position.z);
    _clawAnchor.set(-0.085 * CLAW_SCALE, 0.115 * CLAW_SCALE, 0).applyEuler(_euler).add(this.clawGroup.position);

    this.springMesh.geometry.dispose();
    this.springMesh.geometry = new THREE.TubeGeometry(
      new DynamicClawSpringCurve(_topAnchor, _clawAnchor, SPRING_COILS, SPRING_RADIUS, LATERAL_OFFSET, ph.coilWave, swayX, swayZ),
      SPRING_COILS * 20, SPRING_TUBE, 10, false
    );

  }

  // Detect a prize physically trapped inside the closed finger cage —
  // no kinematic attach: it only rides because the colliders confine it.
  _detectCarried() {
    const cgp = this.clawGroup.position;
    for (const pr of this.prizes) {
      const b = pr.body;
      if (!b || pr.droppingInChute) continue;
      const dx = b.pos.x - cgp.x, dz = b.pos.z - cgp.z;
      if (dx * dx + dz * dz < 0.1156 && b.pos.y > cgp.y - 0.62 && b.pos.y < cgp.y + 0.18 && b.pos.y > FLOOR_Y + 0.3) {
        return pr;
      }
    }
    return null;
  }

  // Full studio grab-cycle state machine + floor-bounce physics step
  updateDemo(dt) {
    if (!(dt > 0)) return; // same-timestamp frames would divide by zero below
    this.t += dt;
    const anim = this.anim;
    const ph = this.phys;

    if (this.phase === 'idle' && this.autoDemo) {
      const avail = this.prizes.filter((p) => !p.droppingInChute);
      const target = avail[this.prizesWon % Math.max(1, avail.length)];
      if (target) {
        this.targetTX = THREE.MathUtils.clamp(target.mesh.position.x, -TRAVEL_X, TRAVEL_X);
        this.targetTZ = THREE.MathUtils.clamp(target.mesh.position.z, -TRAVEL_Z, TRAVEL_Z);
      }
      this.phaseTimer += dt;
      if (this.phaseTimer > 2.8) {
        this.phase = 'descending';
        this.phaseTimer = 0;
        this.phys.bouncesCount = 0;
        this.targetOpen = 0.92;
        this.targetDrop = DROP_MAX;
      }
    } else if (this.phase !== 'idle') {
      this.phaseTimer += dt;

      if (this.phase === 'descending') {
        // Real claw: it rests on the pile (no bounce), rope goes slack, then closes
        if ((ph.supported && this.phaseTimer > 0.6) || this.phaseTimer > 4.5) {
          this.phase = 'touchdown';
          this.phaseTimer = 0;
        }
      } else if (this.phase === 'touchdown') {
        if (this.phaseTimer > 0.75) {
          this.phase = 'grabbing';
          this.phaseTimer = 0;
          this.targetOpen = 0.14;
        }
      } else if (this.phase === 'grabbing') {
        // The motor fights obstructions until the ring actually closes
        // (or gives up after 2.6s like a real stalled mechanism)
        if (anim.currentOpen < 0.3 || this.phaseTimer > 2.6) {
          this.phase = 'hoisting';
          this.phaseTimer = 0;
          ph.groundTiltX = 0;
          ph.groundTiltZ = 0;
          ph.sagX = 0;
          ph.sagZ = 0;
          this.targetDrop = DROP_REST;
          ph.coilWaveVel += 0.9;
          // Wake sleepers near the mouth so whatever got caged/pinched can move
          const cgp = this.clawGroup.position;
          for (const pr of this.prizes) {
            const nb = pr.body;
            if (nb && nb.asleep && nb.pos.distanceToSquared(cgp) < 0.42) {
              nb.asleep = false;
              nb.sleepT = 0;
            }
          }
        }
      } else if (this.phase === 'hoisting') {
        if (Math.abs(anim.currentDrop - DROP_REST) < 0.14 && this.phaseTimer > 2.4) {
          this.phase = 'transporting';
          this.phaseTimer = 0;
          this.targetTX = CHUTE.x;
          this.targetTZ = CHUTE.z;
        }
      } else if (this.phase === 'transporting') {
        const dist = Math.hypot(anim.smoothTX - CHUTE.x, anim.smoothTZ - CHUTE.z);
        if (dist < 0.08 && this.phaseTimer > 1.8) {
          this.phase = 'releasing';
          this.phaseTimer = 0;
          this.targetOpen = 0.9;
          // Nothing to release manually — the prize only leaves the cage when
          // the fingers physically open. If it falls into PRIZE OUT the hole
          // collision counts the win; if it already slipped out mid-flight,
          // this claw run came home empty (just like a real machine).
        }
      } else if (this.phase === 'releasing') {
        if (this.phaseTimer > 1.2) {
          // Stay parked right where the play ended instead of sliding back across the background
          this.autoDemo = false;
          this.phase = 'idle';
          this.phaseTimer = 0;
          this.targetTX = anim.smoothTX;
          this.targetTZ = anim.smoothTZ;
          this.targetDrop = DROP_REST;
          this.targetOpen = 0.82;
        }
      } else if (this.phase === 'returning') {
        if (this.phaseTimer > 1.5) {
          this.autoDemo = false;
          this.phase = 'idle';
          this.phaseTimer = 0;
        }
      }
    }

    // Slow, smooth trolley motion + gentle acceleration feeding the 2D pendulum
    const prevVx = anim.trolleyVelX;
    const prevVz = anim.trolleyVelZ;
    const nextTx = THREE.MathUtils.damp(anim.smoothTX, this.targetTX, 2.2, dt);
    const nextTz = THREE.MathUtils.damp(anim.smoothTZ, this.targetTZ, 2.2, dt);
    anim.trolleyVelX = (nextTx - anim.smoothTX) / dt;
    anim.trolleyVelZ = (nextTz - anim.smoothTZ) / dt;
    const accX = (anim.trolleyVelX - prevVx) / dt;
    const accZ = (anim.trolleyVelZ - prevVz) / dt;
    anim.smoothTX = nextTx;
    anim.smoothTZ = nextTz;

    const carriedMass = this._carried ? 2.65 : 1.8;
    const contact = (this.phase === 'descending' || this.phase === 'touchdown' || this.phase === 'grabbing')
      ? this._clawSupport()
      : null;
    const res = stepClawBouncePhysics(ph, this.targetDrop, dt, 0.74, 52, carriedMass, accX, accZ, contact);
    this.phys = res.next;
    anim.currentDrop = res.next.drop;
    anim.currentOpen = THREE.MathUtils.damp(anim.currentOpen, this.targetOpen, 3.2, dt);

    // Finger stall: a prize jammed between the fingers physically blocks the
    // linkage — the motor keeps pushing but the ring can't close past it.
    // A half-closed ring pinches poorly and the prize slips more easily.
    if (this.phase === 'grabbing' || this.phase === 'hoisting' || this.phase === 'transporting') {
      const cgX = anim.smoothTX + (ph.sagX || 0);
      const cgZ = anim.smoothTZ + (ph.sagZ || 0);
      const cg = this.clawGroup.position;
      let openMin = 0;
      for (const pr of this.prizes) {
        const b = pr.body;
        if (!b || pr.droppingInChute) continue;
        for (const s of b.spheres) {
          const c = this._sphereWorldCenter(b, s, _tmpA);
          // Only prizes in the mid-finger band jam the linkage — the pointed
          // tips sweep UNDER anything at tip depth and scoop it up instead
          if (c.y < cg.y - 0.46 || c.y > cg.y - 0.04) continue;
          const d = Math.hypot(c.x - cgX, c.z - cgZ);
          // Only prizes INSIDE the mouth jam the linkage — prizes outside the
          // finger ring just get pushed aside by the closing sweep
          if (d - s.r > 0.46) continue;
          const needed = Math.max(0, d + s.r * 0.9);
          const om = THREE.MathUtils.clamp((needed / CLAW_SCALE - 0.084) / 0.235, 0, 0.75);
          if (om > openMin) openMin = om;
        }
      }
      // The motor grinds through jams: a blocked prize slows the close but
      // never freezes it — the finger chain keeps squeezing until the prize
      // yields sideways or gets pinched into the cage
      if (openMin > 0.05 && anim.currentOpen < openMin + 0.05) {
        anim.currentOpen = Math.max(this.targetOpen, anim.currentOpen - dt * 0.55);
      }
      // Finger-cam funnel: closing C-curves channel mouth prizes toward the
      // claw axis so the seat forms under their center of mass. During hoist
      // & transport the closed cage cone keeps a carried prize nestled in the
      // pocket (weaker — it only steadies the seat against pendulum sway)
      const funneling = (this.phase === 'touchdown' || this.phase === 'grabbing') && anim.currentOpen > 0.2;
      const riding = (this.phase === 'hoisting' || this.phase === 'transporting');
      if (funneling || riding) {
        const cg2 = this.clawGroup.position;
        const fMul = funneling ? 4.2 : 2.2;
        for (const pr of this.prizes) {
          const b = pr.body;
          if (!b || pr.droppingInChute) continue;
          const dx = cg2.x - b.pos.x, dz = cg2.z - b.pos.z;
          const d = Math.hypot(dx, dz);
          if (d < 0.55 && b.pos.y < cg2.y - 0.02 && b.pos.y > cg2.y - 0.85 && d > 1e-3) {
            const f = fMul * (0.55 - d);
            b.vel.x += (dx / d) * f * dt;
            b.vel.z += (dz / d) * f * dt;
          }
        }
      }
    }

    this._updateVisuals();
    this._carried = this._detectCarried();
    this.grabbedPrize = this._carried;

    // Real rigid-body prize physics (collide with claw, each other, floor, walls & chute)
    this._stepPrizePhysics(dt);
  }
}

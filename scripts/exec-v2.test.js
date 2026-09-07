'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const core=path.resolve(__dirname,'../../TeleBox-Core');
const {buildPlugin}=require(path.join(core,'scripts/build-v2-plugin.cjs'));
const create=require(path.join(buildPlugin({id:'exec',packageRoot:path.resolve(__dirname,'../exec'),entry:'v2.ts'}).artifactDir,'index.cjs')).default;
test('exec delegates command ownership to Core without a duplicate registration',()=>{const plugin=create();assert.equal(plugin.id,'exec');assert.deepEqual(Object.keys(plugin.commands),[]);assert.match(plugin.description,/Core V2/);});
